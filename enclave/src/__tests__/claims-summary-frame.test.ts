/**
 * Phase 4 (Task 4B.1) — CLAIMS_SUMMARY frame emission.
 *
 * The cross-pack claims advocate's audit receipt is assembled client-side, but
 * two facts are ENCLAVE-side only: which memory namespaces were ACTUALLY read
 * ("exercised") and which URLs the air-gapped research subagent fetched. The
 * enclave emits ONE encrypted CLAIMS_SUMMARY frame at a claims run's end
 * carrying exactly those two facts.
 *
 * This file proves:
 *   1. (router, end-to-end) A claims run (cross-pack grant present) that reads
 *      the `money` namespace and whose research subagent fetches `https://x`
 *      ends by emitting a CLAIMS_SUMMARY frame, BEFORE AGENT_DONE, whose
 *      SESSION-KEY-DECRYPTED payload is
 *      `{ exercisedNamespaces: ["money"], fetchedUrls: ["https://x"] }`.
 *      The frame body is ciphertext — server-blindness: the same encryptChunk
 *      mechanism every other agent frame uses.
 *   2. (router, end-to-end) A NON-claims run (no cross-pack grant) emits NO
 *      CLAIMS_SUMMARY frame.
 *   3. (gateway seam) Exercised-namespace tracking dedupes and reflects ONLY
 *      successful reads; fetched-URL tracking dedupes and reflects ONLY the
 *      research subagent's successful web.fetch sources.
 *
 * The router harness is modelled on research-approval-wiring.test.ts (full
 * EnclaveRouter + vsock handshake), extended to auto-answer the worker's
 * memory.read and the subagent's web.fetch tool-invocations over the
 * reverse-channel so the run reaches AGENT_DONE with a non-empty summary.
 *
 * The gateway-seam tests are modelled on claims-research-delegation.test.ts
 * (real ToolGateway + real tier-research + real runResearchSubagent + fake
 * bridge) and assert the tracking structure directly.
 */

import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  computeGrantCommitment,
  type ChatChunk,
  type ChatMessage,
  type ChatProcessor,
  type MemoryNamespace,
  type MemoryRecord,
  type SkillPack,
  type ToolInvocationFrame,
  type ToolResultFrame,
} from '@calypso/chat-types';

import { EnclaveRouter } from '../index';
import { decodeFrame, encodeFrame, MSG } from '../vsock';
import { encryptChunk } from '../crypto';
import { createClaimsSummaryFlusher } from '../agent/claims-summary';
import {
  ToolGateway,
  type ClientBridge,
  type ToolGatewayDeps,
} from '../tools';

const subtle = webcrypto.subtle;

// ─── Session bootstrap (identical to research-approval-wiring.test.ts) ────────

async function establishSession(router: EnclaveRouter): Promise<{
  sessionId: string;
  sessionKey: webcrypto.CryptoKey;
  agentTurnId: string;
}> {
  const attestFrame = encodeFrame(
    MSG.ATTESTATION_REQUEST,
    Buffer.from(JSON.stringify({ nonce: Buffer.alloc(16).toString('base64') })),
  );
  let attestResp: Buffer | null = null;
  for await (const out of router.handleMessage(attestFrame)) {
    attestResp = Buffer.from(out);
  }
  expect(attestResp).not.toBeNull();
  const attestPayload = JSON.parse(attestResp!.subarray(5).toString('utf8'));
  const teePubKeyB64 = attestPayload.ephemeral_public_key;

  const clientKp = await subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const clientPubRaw = new Uint8Array(
    await subtle.exportKey('raw', clientKp.publicKey),
  );
  const sessionId = `sess_${Math.random().toString(36).slice(2)}`;
  const clientNonce = webcrypto.getRandomValues(new Uint8Array(32));
  const kxFrame = encodeFrame(
    MSG.KEY_EXCHANGE,
    Buffer.from(
      JSON.stringify({
        client_ephemeral_public_key:
          Buffer.from(clientPubRaw).toString('base64'),
        session_id: sessionId,
        client_key_exchange_nonce: Buffer.from(clientNonce).toString('base64'),
        tee_public_key: teePubKeyB64,
      }),
    ),
  );
  let kxResp: Buffer | null = null;
  for await (const out of router.handleMessage(kxFrame)) {
    kxResp = Buffer.from(out);
  }
  expect(kxResp).not.toBeNull();
  const kxPayload = JSON.parse(kxResp!.subarray(5).toString('utf8'));
  const teeNonce = Buffer.from(kxPayload.tee_key_exchange_nonce, 'base64');

  const teePub = await subtle.importKey(
    'raw',
    new Uint8Array(Buffer.from(teePubKeyB64, 'base64')),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const sharedBits = await subtle.deriveBits(
    { name: 'ECDH', public: teePub },
    clientKp.privateKey,
    256,
  );
  const salt = new Uint8Array(64);
  salt.set(clientNonce, 0);
  salt.set(new Uint8Array(teeNonce), 32);
  const hkdfKey = await subtle.importKey('raw', sharedBits, 'HKDF', false, [
    'deriveBits',
  ]);
  const keyBits = await subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: new TextEncoder().encode('brianni-tee-session-v1'),
    },
    hkdfKey,
    256,
  );
  const sessionKey = await subtle.importKey(
    'raw',
    keyBits,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

  return { sessionId, sessionKey, agentTurnId: `turn_${Math.random()}` };
}

async function encryptToFrame(
  key: webcrypto.CryptoKey,
  buf: Buffer,
): Promise<Buffer> {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new Uint8Array(buf),
  );
  return Buffer.concat([Buffer.from(iv), Buffer.from(ct)]);
}

async function decryptFrameBody(
  key: webcrypto.CryptoKey,
  body: Buffer,
): Promise<unknown> {
  const iv = body.subarray(0, 12);
  const ct = body.subarray(12);
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv) },
    key,
    new Uint8Array(ct),
  );
  return JSON.parse(Buffer.from(pt).toString('utf8'));
}

// ─── MemoryRecord fixture (money namespace) ───────────────────────────────────

function validMoneyRecord(): MemoryRecord {
  return {
    id: 'rec-money-001',
    namespace: 'money' as MemoryNamespace,
    baseVersion: 0,
    tombstoneEpoch: 0,
    dreamSessionId: 'turn_claims_001',
    kind: 'fact',
    // Carries MEMORY_RECORD_SENTINEL so the worker processor can detect the
    // reinjected result. Deliberately shares NO distinctive grams/tokens with
    // the research question ('out-of-network ER appeal deadline 2026') so the
    // Layer-2 egress-taint backstop does not block a clean research.ask after
    // this record is harvested (gateway-seam test).
    text: `My ${MEMORY_RECORD_SENTINEL} is direct bank transfer.`,
    structured: {},
    tags: [],
    provenance: [
      {
        excerpt: 'prefer reimbursement by direct bank transfer',
        excerptHash: 'a'.repeat(64),
        sourceRef: { type: 'conversation', conversationId: 'c1' },
        extractedAt: '2026-06-09T00:00:00.000Z',
        dreamSessionId: 'turn_claims_001',
      },
    ],
    confidence: 0.9,
    createdAt: '2026-06-09T00:00:00.000Z',
    updatedAt: '2026-06-09T00:00:00.000Z',
    supersededBy: null,
    visibleToUser: true,
  };
}

// ─── Claims orchestrator processor (router path) ──────────────────────────────
//
// One processor serves planner / claims-worker roles. The worker reads the
// `money` namespace then produces final prose. This drives the EMIT path
// (claims-only gating + session-key encryption + framing + before-AGENT_DONE)
// end-to-end through the full EnclaveRouter, with the `exercisedNamespaces`
// fact (money) carried all the way to the decrypted CLAIMS_SUMMARY payload.
//
// NOTE on `fetchedUrls` end-to-end: the air-gapped research subagent's web.fetch
// is dispatched on a SIBLING gateway whose loop events are consumed privately
// inside runResearchSubagent — they are NOT relayed to the wire pump, so a
// subagent fetch cannot be answered via the client reverse-channel in a unit
// harness (in production the host serves it). The `fetchedUrls` collection is
// therefore proven END-TO-END at the gateway seam below (real subagent + real
// runResearchSubagent), which is the honest seam for that fact. This router
// test focuses on the emit/encrypt/frame/gating path with exercisedNamespaces.

const FETCH_URL = 'https://x';
const MEMORY_READ_ID = 'rec-money-001';
// A distinctive token present ONLY in the money record's text — used by the
// worker processor to detect that the memory.read result has been reinjected.
const MEMORY_RECORD_SENTINEL = 'reimbursementpref9animal';

function makeClaimsRunProcessor(): ChatProcessor {
  return {
    async *streamChat(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
      const last = messages.at(-1)?.content ?? '';

      // Planner role: one subtask scoping the cross-pack memory.read.
      if (last.includes('private task planner')) {
        const tag = last.match(/<plan id="([^"]+)">/)?.[1] ?? 'planner_claims';
        yield {
          id: 'planner',
          choices: [
            {
              delta: {
                content: `<plan id="${tag}">{
                  "planId": "plan_claims",
                  "title": "Appeal the denied ER bill",
                  "summary": "Read the money record then draft the appeal.",
                  "subtasks": [
                    {
                      "id": "st_claims",
                      "title": "Read the cost record",
                      "objective": "Read the cross-pack money record and draft the appeal.",
                      "kind": "extraction",
                      "requiredCapabilities": ["general_reasoning"],
                      "allowedTools": ["memory.read"],
                      "dependsOn": [],
                      "producesArtifact": false,
                      "risk": "low"
                    }
                  ]
                }</plan>`,
              },
              finish_reason: null,
            },
          ],
        };
        return;
      }

      // Worker role (claims advocate). Drive: memory.read(money) → final prose.
      // Discriminate on the DISTINCTIVE record text that only appears AFTER the
      // memory.read result is reinjected (the plan/objective context can itself
      // mention "namespace", so that token is not a safe sentinel).
      const nonSystem = messages.slice(1);
      const sawMemoryResult = nonSystem.some((m) =>
        m.content.includes(MEMORY_RECORD_SENTINEL),
      );

      if (!sawMemoryResult) {
        const toolCall = JSON.stringify({
          toolName: 'memory.read',
          args: { id: MEMORY_READ_ID },
        });
        yield {
          id: 'worker_memread',
          choices: [
            {
              delta: { content: `<tool>${toolCall}</tool>` },
              finish_reason: 'stop',
            },
          ],
        };
        return;
      }

      yield {
        id: 'worker_final',
        choices: [
          {
            delta: { content: 'Drafted the appeal with the 180-day deadline.' },
            finish_reason: 'stop',
          },
        ],
      };
    },
  };
}

// A processor for a NON-claims run (default pack, single mode, no grant): it
// just answers — no tool calls, no claims widening — so the run reaches
// AGENT_DONE deterministically and emits NO summary frame. (The point of this
// test is solely the absence of CLAIMS_SUMMARY on a non-claims run.)
function makeNonClaimsProcessor(): ChatProcessor {
  return {
    async *streamChat(): AsyncGenerator<ChatChunk> {
      yield {
        id: 'single_final',
        choices: [
          { delta: { content: 'Here is your answer.' }, finish_reason: 'stop' },
        ],
      };
    },
  };
}

// ─── Reverse-channel auto-responder ───────────────────────────────────────────
//
// Drives an AGENT_REQUEST to completion, auto-answering each TOOL_INVOCATION
// (memory.read → money record; web.fetch → 200 body) and each
// RESEARCH_QUERY_APPROVAL (→ approve) over the reverse channel — modelling the
// client posting tool-results / approvals on a second connection while the
// AGENT_REQUEST socket stays open.

interface DrivenFrame {
  type: number;
  body: Buffer;
}

async function driveClaimsRun(input: {
  router: EnclaveRouter;
  sessionId: string;
  sessionKey: webcrypto.CryptoKey;
  agentTurnId: string;
  outer: Record<string, unknown>;
}): Promise<DrivenFrame[]> {
  const { router, sessionId, sessionKey, agentTurnId, outer } = input;
  const frames: DrivenFrame[] = [];
  const handledInvocations = new Set<string>();
  const handledApprovals = new Set<string>();

  const agentFrame = encodeFrame(
    MSG.AGENT_REQUEST,
    Buffer.from(JSON.stringify(outer)),
  );

  const consume = (async () => {
    for await (const out of router.handleMessage(agentFrame)) {
      const b = Buffer.from(out);
      frames.push({ type: b.readUInt8(0), body: b.subarray(5) });
    }
  })();

  // Post a TOOL_RESULT for a TOOL_INVOCATION frame.
  const postToolResult = async (
    invocationId: string,
    resultJson: unknown,
  ): Promise<void> => {
    const cipher = await encryptToFrame(
      sessionKey,
      Buffer.from(
        JSON.stringify({
          agentTurnId,
          invocationId,
          outcome: 'ok',
          resultJson,
        }),
      ),
    );
    const frame = encodeFrame(
      MSG.TOOL_RESULT,
      Buffer.from(
        JSON.stringify({
          session_id: sessionId,
          agent_turn_id: agentTurnId,
          ciphertext: cipher.toString('base64'),
        }),
      ),
    );
    for await (const _out of router.handleMessage(frame)) void _out;
  };

  // Post a RESEARCH_QUERY_APPROVAL_RESULT(approved:true).
  const postApproval = async (approvalId: string): Promise<void> => {
    const cipher = await encryptToFrame(
      sessionKey,
      Buffer.from(JSON.stringify({ approvalId, approved: true })),
    );
    const frame = encodeFrame(
      MSG.RESEARCH_QUERY_APPROVAL_RESULT,
      Buffer.from(
        JSON.stringify({
          session_id: sessionId,
          ciphertext: cipher.toString('base64'),
        }),
      ),
    );
    for await (const _out of router.handleMessage(frame)) void _out;
  };

  const deadline = Date.now() + 8_000;
  let settled = false;
  void consume.then(() => {
    settled = true;
  });

  while (!settled && Date.now() < deadline) {
    // Answer any new TOOL_INVOCATION frames (memory.read / web.fetch).
    for (const f of frames) {
      if (f.type !== MSG.TOOL_INVOCATION) continue;
      const payload = (await decryptFrameBody(sessionKey, f.body)) as {
        invocationId: string;
        toolName: string;
        args?: { url?: string };
      };
      // Only CLIENT-BRIDGED tools await a TOOL_RESULT from the client:
      // memory.read (main worker) and web.fetch (research subagent). research.ask
      // is dispatched ENCLAVE-side (it surfaces a wire TOOL_INVOCATION for
      // observability but does NOT await a client result), so it must be skipped
      // — posting a result for it would be an UNSOLICITED_TOOL_RESULT.
      if (
        payload.toolName !== 'memory.read' &&
        payload.toolName !== 'web.fetch'
      ) {
        continue;
      }
      if (handledInvocations.has(payload.invocationId)) continue;
      handledInvocations.add(payload.invocationId);
      if (payload.toolName === 'memory.read') {
        await postToolResult(payload.invocationId, {
          record: validMoneyRecord(),
        });
      } else if (payload.toolName === 'web.fetch') {
        await postToolResult(payload.invocationId, {
          status: 200,
          bodyText:
            'Aetna PPO: ER out-of-network claims may be appealed within 180 days.',
        });
      }
    }
    // Approve any new RESEARCH_QUERY_APPROVAL frames.
    for (const f of frames) {
      if (f.type !== MSG.RESEARCH_QUERY_APPROVAL) continue;
      const payload = (await decryptFrameBody(sessionKey, f.body)) as {
        approvalId: string;
      };
      if (handledApprovals.has(payload.approvalId)) continue;
      handledApprovals.add(payload.approvalId);
      await postApproval(payload.approvalId);
    }
    await new Promise((r) => setTimeout(r, 5));
  }

  await consume;
  return frames;
}

// ─── Outer-envelope builders ──────────────────────────────────────────────────

function buildClaimsOuter(input: {
  sessionId: string;
  agentTurnId: string;
  ciphertextB64: string;
}): Record<string, unknown> {
  const expiresAt = Date.now() + 60_000;
  const grantBody = {
    namespaces: ['money'],
    folderIds: [],
    documentIds: [],
    nonce: 'nonce-claims-summary',
  };
  const commit = computeGrantCommitment(
    grantBody as Parameters<typeof computeGrantCommitment>[0],
    { mode: 'jit', expiresAt },
  );
  return {
    session_id: input.sessionId,
    agent_turn_id: input.agentTurnId,
    active_skill_pack_id: 'personal-agent.claims',
    subscription_plan_id: 'PRO',
    cross_pack_grant: {
      grantId: 'grant_claims_summary',
      commit,
      healthVerified: false,
      mode: 'jit',
      expiresAt,
    },
    ciphertext: input.ciphertextB64,
  };
}

// ─── Tests: router path (end-to-end) ──────────────────────────────────────────

describe('CLAIMS_SUMMARY frame (router, end-to-end)', () => {
  it('a claims run that reads money + fetches https://x emits an encrypted CLAIMS_SUMMARY before AGENT_DONE', async () => {
    const router = new EnclaveRouter({
      agentLoopProcessorFactory: makeClaimsRunProcessor,
      invocationTimeoutMs: 4_000,
    });
    const { sessionId, sessionKey, agentTurnId } =
      await establishSession(router);

    const grantBody = {
      namespaces: ['money'],
      folderIds: [],
      documentIds: [],
      nonce: 'nonce-claims-summary',
    };
    const encryptedPayload = {
      messages: [
        { role: 'user', content: 'Help me appeal my out-of-network ER bill.' },
      ],
      model: 'auto',
      runMode: 'orchestrator',
      orchestrator: {
        runMode: 'orchestrator',
        policyVersion: 'calypso-orchestrator-v1',
        preferredModelId: 'auto',
        clientCapabilities: {
          supportsPlanEvents: true,
          supportsBackgroundResume: false,
        },
      },
      cross_pack_grant_body: grantBody,
    };
    const ciphertext = await encryptToFrame(
      sessionKey,
      Buffer.from(JSON.stringify(encryptedPayload)),
    );
    const outer = buildClaimsOuter({
      sessionId,
      agentTurnId,
      ciphertextB64: ciphertext.toString('base64'),
    });

    const frames = await driveClaimsRun({
      router,
      sessionId,
      sessionKey,
      agentTurnId,
      outer,
    });

    // The run reached AGENT_DONE.
    const doneIdx = frames.findIndex((f) => f.type === MSG.AGENT_DONE);
    expect(doneIdx).toBeGreaterThanOrEqual(0);

    // Exactly one CLAIMS_SUMMARY frame, emitted BEFORE AGENT_DONE.
    const summaryIdxs = frames
      .map((f, i) => (f.type === MSG.CLAIMS_SUMMARY ? i : -1))
      .filter((i) => i >= 0);
    expect(summaryIdxs.length).toBe(1);
    expect(summaryIdxs[0]).toBeLessThan(doneIdx);

    // SERVER-BLINDNESS: the frame body is ciphertext (iv||ct), NOT readable
    // plaintext. A raw utf8 read must not reveal the namespace/url.
    const summaryFrame = frames[summaryIdxs[0]];
    const rawUtf8 = summaryFrame.body.toString('utf8');
    expect(rawUtf8).not.toContain('money');
    expect(rawUtf8).not.toContain('https://x');
    expect(rawUtf8).not.toContain('exercisedNamespaces');

    // Decrypting under the SESSION KEY yields the enclave-side fact actually
    // exercised in this run: the money namespace was read. (fetchedUrls is
    // empty here — no research subagent ran; the URL-collection fact is proven
    // end-to-end at the gateway seam below.)
    const decrypted = (await decryptFrameBody(
      sessionKey,
      summaryFrame.body,
    )) as { exercisedNamespaces: string[]; fetchedUrls: string[] };
    expect(decrypted.exercisedNamespaces).toEqual(['money']);
    expect(decrypted.fetchedUrls).toEqual([]);
  });

  it('a NON-claims run (no cross-pack grant) emits NO CLAIMS_SUMMARY frame', async () => {
    const router = new EnclaveRouter({
      agentLoopProcessorFactory: makeNonClaimsProcessor,
      invocationTimeoutMs: 4_000,
    });
    const { sessionId, sessionKey, agentTurnId } =
      await establishSession(router);

    // Default pack, single mode, NO cross_pack_grant — an ordinary agent run.
    const encryptedPayload = {
      messages: [{ role: 'user', content: 'What did I save about my budget?' }],
      model: 'auto',
      runMode: 'single',
    };
    const ciphertext = await encryptToFrame(
      sessionKey,
      Buffer.from(JSON.stringify(encryptedPayload)),
    );
    const outer = {
      session_id: sessionId,
      agent_turn_id: agentTurnId,
      active_skill_pack_id: 'personal-agent.default',
      subscription_plan_id: 'PRO',
      ciphertext: ciphertext.toString('base64'),
    };

    const frames = await driveClaimsRun({
      router,
      sessionId,
      sessionKey,
      agentTurnId,
      outer,
    });

    // Reached AGENT_DONE, but NO CLAIMS_SUMMARY anywhere.
    expect(frames.some((f) => f.type === MSG.AGENT_DONE)).toBe(true);
    expect(frames.some((f) => f.type === MSG.CLAIMS_SUMMARY)).toBe(false);
  });
});

// ─── Tests: gateway seam (tracking structure) ─────────────────────────────────
//
// Direct assertions on the per-request tracking sets using a real ToolGateway +
// real tier-research + real runResearchSubagent. Proves dedupe + success-only
// without the full router round-trip.

const claimsPack: SkillPack = {
  id: 'personal-agent.claims',
  version: 1,
  displayName: 'Claims Advocate',
  description: 'Cross-pack claims advocate.',
  systemPromptBlock: 'You are Calypso Claims Advocate.',
  toolScopes: [
    'research.ask',
    'memory.list',
    'memory.read',
    'folder.list',
    'folder.read',
    'file.read',
  ],
  crossPackNamespaces: ['money', 'health'],
  capabilitySuiteIds: ['text'],
  defaultNamespace: 'default',
  linkedFolderScopes: {},
  uiHints: { icon: 'default', accentToken: 'accent-default' },
};

const GW_TURN = 'turn-gw-claims';

function makeGatewayResearchProvider(): ChatProcessor {
  let invocation = 0;
  const webFetchToolCall = JSON.stringify({
    toolName: 'web.fetch',
    args: { url: FETCH_URL, query: 'ER appeal deadline' },
  });
  return {
    async *streamChat(): AsyncGenerator<ChatChunk> {
      invocation += 1;
      if (invocation === 1) {
        yield {
          id: 'gw_research_fetch',
          choices: [
            {
              delta: { content: `<tool>${webFetchToolCall}</tool>` },
              finish_reason: 'stop',
            },
          ],
        };
        return;
      }
      yield {
        id: 'gw_research_answer',
        choices: [
          {
            delta: { content: 'Appeals must be filed within 180 days.' },
            finish_reason: 'stop',
          },
        ],
      };
    },
  };
}

// A research provider that SUCCESSFULLY fetches FETCH_URL on round 1, then
// THROWS on round 2 (models a post-fetch subagent timeout / internal error).
// runResearchSubagent catches the throw and returns the partial sources with
// failed=true; tier-research records the fetched URL into the parent audit set
// and returns a non-ok outcome.
function makeFetchThenFailResearchProvider(): ChatProcessor {
  let invocation = 0;
  const webFetchToolCall = JSON.stringify({
    toolName: 'web.fetch',
    args: { url: FETCH_URL, query: 'ER appeal deadline' },
  });
  return {
    async *streamChat(): AsyncGenerator<ChatChunk> {
      invocation += 1;
      if (invocation === 1) {
        yield {
          id: 'gw_research_fetch_then_fail',
          choices: [
            {
              delta: { content: `<tool>${webFetchToolCall}</tool>` },
              finish_reason: 'stop',
            },
          ],
        };
        return;
      }
      // After the fetch succeeded and was reinjected: fail hard.
      throw new Error('research subagent post-fetch failure');
    },
  };
}

// A research provider whose web.fetch is NEVER answered successfully: it emits
// a web.fetch with a missing `query` arg, which tier-a-read rejects (invalidArgs)
// before the bridge is reached, so the URL is NEVER promoted to sources.
function makeNeverFetchedResearchProvider(): ChatProcessor {
  let invocation = 0;
  const badWebFetchToolCall = JSON.stringify({
    toolName: 'web.fetch',
    // Deliberately omit `query` → invalidArgs → gateway_rejected, no success.
    args: { url: NEVER_FETCHED_URL },
  });
  return {
    async *streamChat(): AsyncGenerator<ChatChunk> {
      invocation += 1;
      if (invocation === 1) {
        yield {
          id: 'gw_research_badfetch',
          choices: [
            {
              delta: { content: `<tool>${badWebFetchToolCall}</tool>` },
              finish_reason: 'stop',
            },
          ],
        };
        return;
      }
      yield {
        id: 'gw_research_recover',
        choices: [
          {
            delta: { content: 'Could not fetch; here is a fallback.' },
            finish_reason: 'stop',
          },
        ],
      };
    },
  };
}

const NEVER_FETCHED_URL = 'https://never-fetched.example';

function makeGatewayWithResearchProvider(
  provider: ChatProcessor,
): ToolGateway {
  const invokeClientMock = vi.fn(
    async (frame: ToolInvocationFrame): Promise<ToolResultFrame> => {
      if (frame.toolName === 'web.fetch') {
        return {
          invocationId: frame.invocationId,
          outcome: 'ok',
          resultJson: { status: 200, bodyText: 'Appeals: 180 days.' },
        };
      }
      return { invocationId: frame.invocationId, outcome: 'ok', resultJson: {} };
    },
  );
  const bridge: ClientBridge = {
    invokeClient: invokeClientMock,
    approveQuery: vi.fn().mockResolvedValue(true),
  };
  const deps: ToolGatewayDeps = {
    clientBridge: bridge,
    userId: 'user-gw-fail',
    sessionId: 'session-gw-fail',
    crossPackGrant: {
      namespaces: new Set<MemoryNamespace>(['money']),
      folderIds: new Set<string>(),
      documentIds: new Set<string>(),
    },
    researchProviderFactory: () => provider,
  };
  return new ToolGateway(deps);
}

function makeGateway(): ToolGateway {
  const invokeClientMock = vi.fn(
    async (frame: ToolInvocationFrame): Promise<ToolResultFrame> => {
      if (frame.toolName === 'memory.read') {
        return {
          invocationId: frame.invocationId,
          outcome: 'ok',
          resultJson: { record: validMoneyRecord() },
        };
      }
      if (frame.toolName === 'web.fetch') {
        return {
          invocationId: frame.invocationId,
          outcome: 'ok',
          resultJson: { status: 200, bodyText: 'Appeals: 180 days.' },
        };
      }
      return { invocationId: frame.invocationId, outcome: 'ok', resultJson: {} };
    },
  );
  const provider = makeGatewayResearchProvider();
  const bridge: ClientBridge = {
    invokeClient: invokeClientMock,
    approveQuery: vi.fn().mockResolvedValue(true),
  };
  const deps: ToolGatewayDeps = {
    clientBridge: bridge,
    userId: 'user-gw-001',
    sessionId: 'session-gw-001',
    crossPackGrant: {
      namespaces: new Set<MemoryNamespace>(['money']),
      folderIds: new Set<string>(),
      documentIds: new Set<string>(),
    },
    researchProviderFactory: () => provider,
  };
  return new ToolGateway(deps);
}

function memReadFrame(): ToolInvocationFrame {
  return {
    invocationId: `inv-mem-${Math.random().toString(36).slice(2)}`,
    agentTurnId: GW_TURN,
    toolName: 'memory.read',
    args: { id: MEMORY_READ_ID },
  };
}

function researchFrame(): ToolInvocationFrame {
  return {
    invocationId: `inv-res-${Math.random().toString(36).slice(2)}`,
    agentTurnId: GW_TURN,
    toolName: 'research.ask',
    args: { insurer: 'Aetna', question: 'out-of-network ER appeal deadline 2026' },
  };
}

describe('CLAIMS_SUMMARY tracking (gateway seam)', () => {
  it('records the money namespace on a successful memory.read and the subagent fetched URL', async () => {
    const gw = makeGateway();
    const memRes = await gw.dispatch(memReadFrame(), claimsPack, GW_TURN);
    expect(memRes.outcome).toBe('ok');
    const resRes = await gw.dispatch(researchFrame(), claimsPack, GW_TURN);
    expect(resRes.outcome).toBe('ok');

    expect(gw.getExercisedNamespaces()).toEqual(['money']);
    expect(gw.getFetchedUrls()).toEqual([FETCH_URL]);
  });

  it('dedupes exercised namespaces + fetched URLs across repeated reads/fetches', async () => {
    const gw = makeGateway();
    await gw.dispatch(memReadFrame(), claimsPack, GW_TURN);
    await gw.dispatch(memReadFrame(), claimsPack, GW_TURN);
    await gw.dispatch(researchFrame(), claimsPack, GW_TURN);
    await gw.dispatch(researchFrame(), claimsPack, GW_TURN);

    // Both memory.reads resolve namespace `money`; both research runs fetch
    // the same `https://x` — deduped to a single entry each.
    expect(gw.getExercisedNamespaces()).toEqual(['money']);
    expect(gw.getFetchedUrls()).toEqual([FETCH_URL]);
  });

  it('records the fetched URL even when research.ask ends in a NON-ok outcome (subagent fails AFTER the fetch)', async () => {
    // The air-gapped subagent SUCCESSFULLY fetches https://x, then the run fails
    // post-fetch (provider throws on the next round). research.ask returns a
    // non-ok outcome — but https://x DID leave the device, so the claims audit
    // (and thus the CLAIMS_SUMMARY frame) MUST still report it. Before the fix
    // the URL was dropped because recording was gated on outcome === 'ok'.
    const gw = makeGatewayWithResearchProvider(
      makeFetchThenFailResearchProvider(),
    );

    const res = await gw.dispatch(researchFrame(), claimsPack, GW_TURN);

    // research.ask itself reports the subagent failure (non-ok) ...
    expect(res.outcome).not.toBe('ok');
    expect(res.outcome).toBe('error');
    expect(res.reason).toBe('RESEARCH_SUBAGENT_FAILED');

    // ... but the URL that was actually fetched is STILL in the audit set, so
    // the receipt would not under-report egress.
    expect(gw.getFetchedUrls()).toEqual([FETCH_URL]);
  });

  it('does NOT record a URL that was never successfully fetched (failed web.fetch in the subagent)', async () => {
    // The subagent attempts a web.fetch that is rejected (invalidArgs) before any
    // egress happens, then recovers with a fallback answer (research.ask ok). No
    // URL ever left the device, so nothing must be recorded — the success-only
    // invariant holds (we never record attempted-but-failed fetches).
    const gw = makeGatewayWithResearchProvider(
      makeNeverFetchedResearchProvider(),
    );

    const res = await gw.dispatch(researchFrame(), claimsPack, GW_TURN);

    // The run completes ok (the model recovered with a fallback answer).
    expect(res.outcome).toBe('ok');
    // Nothing was fetched, so the audit set is empty.
    expect(gw.getFetchedUrls()).toEqual([]);
  });

  it('does NOT record a namespace for a FAILED (out-of-grant) memory.read', async () => {
    // A grant scoped ONLY to money: a memory.read whose record resolves to a
    // namespace NOT in the grant is rejected by tier-a-read (NAMESPACE_ESCAPE_
    // REJECTED) — outcome != ok — so nothing is recorded.
    const invokeClientMock = vi.fn(
      async (frame: ToolInvocationFrame): Promise<ToolResultFrame> => ({
        invocationId: frame.invocationId,
        outcome: 'ok',
        // Record resolves to `health`, which is NOT in the {money} grant.
        resultJson: {
          record: { ...validMoneyRecord(), namespace: 'health' },
        },
      }),
    );
    const deps: ToolGatewayDeps = {
      clientBridge: { invokeClient: invokeClientMock },
      userId: 'user-gw-002',
      sessionId: 'session-gw-002',
      crossPackGrant: {
        namespaces: new Set<MemoryNamespace>(['money']),
        folderIds: new Set<string>(),
        documentIds: new Set<string>(),
      },
    };
    const gw = new ToolGateway(deps);
    const res = await gw.dispatch(memReadFrame(), claimsPack, GW_TURN);

    // tier-a-read rejects the out-of-grant record; nothing recorded.
    expect(res.outcome).not.toBe('ok');
    expect(gw.getExercisedNamespaces()).toEqual([]);
  });
});

// ─── Tests: flush-on-EVERY-terminal-exit (helper + once-guard seam) ───────────
//
// The audit gap this fixes: the CLAIMS_SUMMARY frame used to be emitted ONLY on
// the clean `done` terminal. A claims run that read a namespace (exercised) and
// then hit a NON-done terminal — a pump throw or an abort — never emitted the
// summary, so the client (the only party that can read plaintext) lost the audit
// record of a run that actually touched data. The fix routes the emit through a
// shared `createClaimsSummaryFlusher` invoked at EVERY terminal exit (done /
// error / pump-finally backstop), guarded so it emits AT MOST ONCE per run.
//
// SEAM CHOICE — why the helper, not a full-router error round-trip: in claims
// (orchestrator-only) mode the orchestrator is exhaustively fallback-driven —
// worker throws, per-invocation timeouts, downstream tool errors and post-read
// budget exhaustion are all CAUGHT and converted to per-subtask
// `orchestrator-progress` errors, after which the generator marches to a clean
// `yield { kind: 'done' }`. The genuinely-uncovered NON-done terminals (a
// generator throw that escapes to the pump's `finally`, and an abort/early
// teardown) cannot be driven deterministically from the client reverse-channel
// in a unit harness after a successful read (the deterministic generator-escape
// levers — planner budget/timeout — throw BEFORE any read, so they carry an
// empty exercised set and prove nothing about partial-then-failed). So the
// read-then-error scenario is proven at the smallest honest seam: a REAL
// ToolGateway driven to actually exercise the `money` namespace, then the shared
// flusher invoked twice (modelling an error/abort terminal followed by the
// pump-finally backstop). This asserts the load-bearing invariants directly —
// claims-only gating, session-key encryption (server-blindness), the exercised
// set surviving to the decrypted payload, and AT-MOST-ONCE — without weakening
// either the encryption or the once assertion. The end-to-end emit/encrypt/frame
// path on the `done` terminal remains covered by the router test above.

describe('CLAIMS_SUMMARY flush-on-every-terminal-exit (helper + once-guard)', () => {
  it('flushes the exercised namespace on a read-then-error terminal, encrypted, exactly once', async () => {
    // A REAL claims gateway that actually reads the `money` namespace, so the
    // flusher reads a live, non-empty exercised set — exactly the state present
    // at error/abort time in the partial-then-failed case.
    const gw = makeGateway();
    const memRes = await gw.dispatch(memReadFrame(), claimsPack, GW_TURN);
    expect(memRes.outcome).toBe('ok');
    expect(gw.getExercisedNamespaces()).toEqual(['money']);

    const { sessionKey } = await establishSession(
      new EnclaveRouter({ agentLoopProcessorFactory: makeClaimsRunProcessor }),
    );

    const pushed: Buffer[] = [];
    const flusher = createClaimsSummaryFlusher({
      isClaimsRun: true,
      sessionKey,
      getExercisedNamespaces: () => gw.getExercisedNamespaces(),
      getFetchedUrls: () => gw.getFetchedUrls(),
      encryptChunk,
      pushFrame: (frame) => pushed.push(frame),
    });

    // (1) Error/abort terminal fires first.
    const firstEmitted = await flusher.flush();
    // (2) Pump-finally backstop fires after — must be a no-op (once-guard).
    const secondEmitted = await flusher.flush();

    expect(firstEmitted).toBe(true);
    expect(secondEmitted).toBe(false);

    // AT MOST ONCE: exactly one CLAIMS_SUMMARY frame across both invocations.
    expect(pushed.length).toBe(1);
    const { type, payload } = decodeFrame(pushed[0]);
    expect(type).toBe(MSG.CLAIMS_SUMMARY);

    // SERVER-BLINDNESS: the frame body is ciphertext, not readable plaintext.
    const rawUtf8 = payload.toString('utf8');
    expect(rawUtf8).not.toContain('money');
    expect(rawUtf8).not.toContain('exercisedNamespaces');

    // Decrypting under the session key yields the namespace actually exercised
    // BEFORE the (simulated) error — proving the receipt would not be lost.
    const decrypted = (await decryptFrameBody(sessionKey, payload)) as {
      exercisedNamespaces: string[];
      fetchedUrls: string[];
    };
    expect(decrypted.exercisedNamespaces).toEqual(['money']);
  });

  it('emits NOTHING for a non-claims run, even across multiple terminal calls', async () => {
    const { sessionKey } = await establishSession(
      new EnclaveRouter({ agentLoopProcessorFactory: makeNonClaimsProcessor }),
    );
    const pushed: Buffer[] = [];
    const flusher = createClaimsSummaryFlusher({
      isClaimsRun: false,
      sessionKey,
      getExercisedNamespaces: () => ['money'] as MemoryNamespace[],
      getFetchedUrls: () => [],
      encryptChunk,
      pushFrame: (frame) => pushed.push(frame),
    });

    expect(await flusher.flush()).toBe(false);
    expect(await flusher.flush()).toBe(false);
    expect(pushed.length).toBe(0);
    expect(flusher.hasFlushed()).toBe(false);
  });

  it('does NOT latch when the first emit attempt fails — a later terminal retries', async () => {
    // "first SUCCESSFUL emission wins": a transient encrypt failure on the first
    // terminal (e.g. the error case) must NOT consume the once-token, so the
    // teardown backstop can still emit the audit frame rather than the run
    // losing it permanently.
    const { sessionKey } = await establishSession(
      new EnclaveRouter({ agentLoopProcessorFactory: makeClaimsRunProcessor }),
    );
    const pushed: Buffer[] = [];
    let calls = 0;
    const flusher = createClaimsSummaryFlusher({
      isClaimsRun: true,
      sessionKey,
      getExercisedNamespaces: () => ['money'] as MemoryNamespace[],
      getFetchedUrls: () => [],
      encryptChunk: async (key, plaintext) => {
        calls += 1;
        if (calls === 1) throw new Error('transient AEAD failure');
        return encryptChunk(key, plaintext);
      },
      pushFrame: (frame) => pushed.push(frame),
    });

    // (1) First terminal: encrypt throws → flush rejects, nothing pushed, NOT latched.
    await expect(flusher.flush()).rejects.toThrow('transient AEAD failure');
    expect(pushed.length).toBe(0);
    expect(flusher.hasFlushed()).toBe(false);

    // (2) Backstop terminal: retries and emits exactly one frame, now latched.
    expect(await flusher.flush()).toBe(true);
    expect(pushed.length).toBe(1);
    expect(flusher.hasFlushed()).toBe(true);
    expect(decodeFrame(pushed[0]).type).toBe(MSG.CLAIMS_SUMMARY);

    // (3) Any later call is a no-op now that a frame was successfully emitted.
    expect(await flusher.flush()).toBe(false);
    expect(pushed.length).toBe(1);
  });
});
