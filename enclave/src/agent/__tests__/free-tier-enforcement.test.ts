/**
 * B4 (docs/launch/agent-capability-verification.md §3) — FREE-tier
 * enforcement is ENCLAVE-side, not just UI.
 *
 * The client gate (CalypsoTaskWorkspace.tsx:237) is UX, not security. This
 * suite is the security claim: crafted AGENT_REQUESTs that claim
 * `subscription_plan_id: "FREE"` (or a malformed plan id) must be unable to
 * cheat their way into paid capabilities REGARDLESS of what the client sent
 * inside the encrypted body. Every request here goes through the real
 * EnclaveRouter wire path (attestation → ECDH key exchange → encrypted
 * AGENT_REQUEST), exactly like enclave/src/__tests__/agent-wire.test.ts.
 *
 * Cheat vectors and where the enclave enforces them:
 *   V1 runMode "orchestrator"        → enclave/src/index.ts (AGENT_REQUEST
 *      handler): FREE + orchestrator → CHAT_ERROR
 *      ORCHESTRATOR_REQUIRES_PAID_PLAN before any provider call.
 *   V2 web.fetch / research.ask / media tools → scopePackToPlan narrows
 *      pack.toolScopes for FREE (packages/chat-types/skills/index.ts), and
 *      ToolGateway.prepareInvocation / dispatch reject OUT_OF_SCOPE
 *      (enclave/src/tools/index.ts) before any TOOL_INVOCATION reaches the
 *      wire.
 *   V3 5th tool call                 → maxToolCalls = FREE_AGENT_MAX_TOOL_CALLS
 *      (4) wired in enclave/src/index.ts; runAgentLoop emits
 *      TOOL_LIMIT_EXCEEDED (enclave/src/agent/loop.ts).
 *   V4 aggregate reads > 256 KiB     → readAggregateByteCap =
 *      FREE_AGENT_READ_AGGREGATE_BYTES wired in enclave/src/index.ts;
 *      ToolGateway.dispatch rejects TOOL_RESULT_TOO_LARGE cumulatively
 *      across the turn (enclave/src/tools/index.ts).
 *   V5 malformed plan id             → readAgentSubscriptionPlanId
 *      (enclave/src/index.ts) fails closed to FREE — never up.
 *
 * NOTE: enclave/src/__tests__/free-tier-tools.test.ts unit-tests the
 * scopePackToPlan narrowing function in isolation; this file deliberately
 * does NOT repeat that. It proves the narrowing (and the other four gates)
 * actually bind on a hostile end-to-end request.
 */

import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  ChatChunk,
  ChatMessage,
  ChatProcessor,
} from '@calypso/chat-types';

import { EnclaveRouter } from '../../index';
import { encodeFrame, MSG } from '../../vsock';
import {
  FREE_AGENT_MAX_TOOL_CALLS,
  FREE_AGENT_READ_AGGREGATE_BYTES,
} from '../free-tier-tools';
import { sanitizeToolOutputForModel } from '../tool-output-sanitizer';

const subtle = webcrypto.subtle;

// ─── Wire helpers (same protocol as agent-wire.test.ts) ───────────────────────

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
        client_ephemeral_public_key: Buffer.from(clientPubRaw).toString('base64'),
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

async function decryptFromFrame(
  key: webcrypto.CryptoKey,
  body: Buffer,
): Promise<Buffer> {
  const iv = new Uint8Array(body.subarray(0, 12));
  const ct = body.subarray(12);
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    new Uint8Array(ct),
  );
  return Buffer.from(pt);
}

/**
 * A scripted provider that RECORDS every transcript it is invoked with.
 * `scripts[i]` is the token stream for provider call i; calls past the end
 * replay the LAST script (so a "model that never stops calling tools" is
 * just a one-element script).
 */
function makeScriptedProcessor(scripts: string[][]): {
  processor: ChatProcessor;
  transcripts: ChatMessage[][];
} {
  const transcripts: ChatMessage[][] = [];
  let invocation = 0;
  const processor: ChatProcessor = {
    async *streamChat(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
      transcripts.push(messages.map((m) => ({ ...m })));
      const tokens = scripts[Math.min(invocation, scripts.length - 1)] ?? [];
      invocation += 1;
      for (let i = 0; i < tokens.length; i += 1) {
        yield {
          id: `chunk_${invocation}_${i}`,
          choices: [
            {
              delta: { content: tokens[i] },
              finish_reason: i === tokens.length - 1 ? 'stop' : null,
            },
          ],
        };
      }
    },
  };
  return { processor, transcripts };
}

/** Planner-aware processor for the PRO orchestrator control (mirrors agent-orchestrator-wire.test.ts). */
function makeOrchestratorProcessor(): ChatProcessor {
  return {
    async *streamChat(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
      const last = messages.at(-1)?.content ?? '';
      if (last.includes('private task planner')) {
        const tag = last.match(/<plan id="([^"]+)">/)?.[1] ?? 'planner_test';
        yield {
          id: 'planner',
          choices: [
            {
              delta: {
                content: `<plan id="${tag}">{
                  "planId": "plan_b4",
                  "title": "Application materials",
                  "summary": "Draft the requested letter.",
                  "subtasks": [
                    {
                      "id": "st_1",
                      "title": "Draft letter",
                      "objective": "Draft the application letter.",
                      "kind": "writing",
                      "requiredCapabilities": ["writing"],
                      "allowedTools": [],
                      "dependsOn": [],
                      "producesArtifact": true,
                      "risk": "medium"
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
      yield {
        id: 'worker',
        choices: [{ delta: { content: 'Draft complete.' }, finish_reason: null }],
      };
    },
  };
}

const toolFence = (toolName: string, args: Record<string, unknown>): string =>
  `<tool>${JSON.stringify({ toolName, args })}</tool>`;

/** The crafted orchestrator body a cheating client would send (encrypted inner JSON). */
const orchestratorCheatBody = {
  messages: [{ role: 'user', content: 'Write an application letter.' }],
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
};

interface TurnResult {
  frames: Array<{ type: number; body: Buffer }>;
  /** Plaintext CHAT_ERROR payloads. */
  errors: Array<{ error_code?: string; message?: string }>;
  /** Decrypted `_type: "ledger"` chunk entries (tool-call audit trail). */
  ledgerEntries: Array<{ toolName: string; outcome: string; reason?: string }>;
  /** Decrypted TOOL_INVOCATION wire frames the CLIENT was asked to fulfil. */
  toolInvocations: Array<{ toolName: string; invocationId: string }>;
  /** Decrypted CHAT_CHUNK payloads (all _type variants + plain text). */
  chunks: Array<Record<string, unknown>>;
  doneCount: number;
}

/**
 * Drive one AGENT_REQUEST end-to-end. `subscriptionPlanId` rides the OUTER
 * plaintext envelope exactly as the server would forward it — `unknown`
 * typed on purpose so malformed values can be injected. When
 * `fulfilToolInvocation` returns a resultJson, the helper plays the client:
 * it answers each TOOL_INVOCATION with an encrypted MSG.TOOL_RESULT on a
 * detached handleMessage call (the second-vsock-connection pattern from
 * agent-wire.test.ts).
 */
async function runAgentTurn(input: {
  router: EnclaveRouter;
  sessionId: string;
  sessionKey: webcrypto.CryptoKey;
  agentTurnId: string;
  body: Record<string, unknown>;
  subscriptionPlanId?: unknown;
  fulfilToolInvocation?: (wire: {
    toolName: string;
    invocationId: string;
    args: unknown;
  }) => unknown;
}): Promise<TurnResult> {
  const ciphertext = await encryptToFrame(
    input.sessionKey,
    Buffer.from(JSON.stringify(input.body)),
  );
  const outer: Record<string, unknown> = {
    session_id: input.sessionId,
    agent_turn_id: input.agentTurnId,
    active_skill_pack_id: 'personal-agent.default',
    ciphertext: ciphertext.toString('base64'),
  };
  if (input.subscriptionPlanId !== undefined) {
    outer.subscription_plan_id = input.subscriptionPlanId;
  }
  const frame = encodeFrame(
    MSG.AGENT_REQUEST,
    Buffer.from(JSON.stringify(outer)),
  );

  const result: TurnResult = {
    frames: [],
    errors: [],
    ledgerEntries: [],
    toolInvocations: [],
    chunks: [],
    doneCount: 0,
  };

  for await (const out of input.router.handleMessage(frame)) {
    const b = Buffer.from(out);
    const type = b.readUInt8(0);
    const body = b.subarray(5);
    result.frames.push({ type, body });

    if (type === MSG.AGENT_DONE) {
      result.doneCount += 1;
    } else if (type === MSG.CHAT_ERROR) {
      // Error frames cross the vsock boundary UNENCRYPTED (H1).
      try {
        result.errors.push(JSON.parse(body.toString('utf8')));
      } catch {
        result.errors.push({});
      }
    } else if (type === MSG.CHAT_CHUNK) {
      const plain = JSON.parse(
        (await decryptFromFrame(input.sessionKey, body)).toString('utf8'),
      ) as Record<string, unknown>;
      result.chunks.push(plain);
      if (plain._type === 'ledger' && plain.entry) {
        result.ledgerEntries.push(
          plain.entry as { toolName: string; outcome: string; reason?: string },
        );
      }
    } else if (type === MSG.TOOL_INVOCATION) {
      const wire = JSON.parse(
        (await decryptFromFrame(input.sessionKey, body)).toString('utf8'),
      ) as { toolName: string; invocationId: string; args: unknown };
      result.toolInvocations.push({
        toolName: wire.toolName,
        invocationId: wire.invocationId,
      });
      const resultJson = input.fulfilToolInvocation?.(wire);
      if (resultJson !== undefined) {
        const resultPayload = await encryptToFrame(
          input.sessionKey,
          Buffer.from(
            JSON.stringify({
              agentTurnId: input.agentTurnId,
              invocationId: wire.invocationId,
              outcome: 'ok',
              resultJson,
            }),
          ),
        );
        const trFrame = encodeFrame(
          MSG.TOOL_RESULT,
          Buffer.from(
            JSON.stringify({
              session_id: input.sessionId,
              agent_turn_id: input.agentTurnId,
              ciphertext: resultPayload.toString('base64'),
            }),
          ),
        );
        // Detached drive — the loop is suspended awaiting the bridge resolver.
        (async () => {
          for await (const _ of input.router.handleMessage(trFrame)) {
            /* drain */
          }
        })().catch(() => undefined);
      }
    }
  }
  return result;
}

const allTranscriptText = (transcripts: ChatMessage[][]): string =>
  transcripts
    .flat()
    .map((m) => m.content)
    .join('\n');

// ─── V1 — runMode "orchestrator" with a FREE plan ─────────────────────────────

describe('B4 V1 — FREE cannot enter orchestrator mode', () => {
  it('FREE + runMode "orchestrator" → ORCHESTRATOR_REQUIRES_PAID_PLAN, zero provider calls, zero tool frames', async () => {
    const { processor, transcripts } = makeScriptedProcessor([
      ['should-never-run.'],
    ]);
    const router = new EnclaveRouter({
      agentLoopProcessorFactory: () => processor,
    });
    const { sessionId, sessionKey, agentTurnId } = await establishSession(router);

    const turn = await runAgentTurn({
      router,
      sessionId,
      sessionKey,
      agentTurnId,
      subscriptionPlanId: 'FREE',
      body: orchestratorCheatBody,
    });

    expect(turn.errors).toContainEqual(
      expect.objectContaining({ error_code: 'ORCHESTRATOR_REQUIRES_PAID_PLAN' }),
    );
    // Hard stop: no model call, no tool dispatch, no completion signal.
    expect(transcripts).toHaveLength(0);
    expect(turn.toolInvocations).toHaveLength(0);
    expect(turn.doneCount).toBe(0);
    expect(turn.chunks).toHaveLength(0);
  });

  it('control: the IDENTICAL body with PRO reaches the orchestrator (rejection is plan-driven, not body-driven)', async () => {
    const router = new EnclaveRouter({
      agentLoopProcessorFactory: makeOrchestratorProcessor,
    });
    const { sessionId, sessionKey, agentTurnId } = await establishSession(router);

    const turn = await runAgentTurn({
      router,
      sessionId,
      sessionKey,
      agentTurnId,
      subscriptionPlanId: 'PRO',
      body: orchestratorCheatBody,
    });

    expect(turn.errors).not.toContainEqual(
      expect.objectContaining({ error_code: 'ORCHESTRATOR_REQUIRES_PAID_PLAN' }),
    );
    expect(
      turn.chunks.some((chunk) => chunk._type === 'orchestrator_plan'),
    ).toBe(true);
  });

  it('FREE cannot smuggle orchestrator mode via the NESTED orchestrator.runMode — the turn runs single-mode', async () => {
    const { processor, transcripts } = makeScriptedProcessor([['Hello.']]);
    const router = new EnclaveRouter({
      agentLoopProcessorFactory: () => processor,
    });
    const { sessionId, sessionKey, agentTurnId } = await establishSession(router);

    const { runMode: _dropped, ...bodyWithoutTopLevelRunMode } =
      orchestratorCheatBody;
    const turn = await runAgentTurn({
      router,
      sessionId,
      sessionKey,
      agentTurnId,
      subscriptionPlanId: 'FREE',
      // No top-level runMode; the nested orchestrator context still claims
      // runMode "orchestrator". The enclave derives the authoritative mode
      // from the TOP-LEVEL field only and overrides the nested claim.
      body: bodyWithoutTopLevelRunMode,
    });

    // Single-mode path ran: plain text chunk, no plan events, clean done.
    expect(turn.errors).toHaveLength(0);
    expect(turn.doneCount).toBe(1);
    expect(
      turn.chunks.some(
        (chunk) =>
          typeof chunk._type === 'string' &&
          (chunk._type as string).startsWith('orchestrator'),
      ),
    ).toBe(false);
    expect(transcripts).toHaveLength(1);
  });
});

// ─── V2 — paid tools are OUT_OF_SCOPE for FREE ───────────────────────────────

describe('B4 V2 — FREE cannot dispatch web.fetch / research.ask / media tools', () => {
  it('FREE model prompt explains that external service connectors require PRO or MAX', async () => {
    const { processor, transcripts } = makeScriptedProcessor([
      ['I can draft a plan manually.'],
    ]);
    const router = new EnclaveRouter({
      agentLoopProcessorFactory: () => processor,
    });
    const { sessionId, sessionKey, agentTurnId } = await establishSession(router);

    const turn = await runAgentTurn({
      router,
      sessionId,
      sessionKey,
      agentTurnId,
      subscriptionPlanId: 'FREE',
      body: {
        messages: [{ role: 'user', content: "Read tomorrow's calendar" }],
        model: 'test-model',
      },
    });

    expect(turn.doneCount).toBe(1);
    expect(transcripts).toHaveLength(1);
    const systemPrompt = transcripts[0][0];
    expect(systemPrompt.role).toBe('system');
    expect(systemPrompt.content).toContain(
      'External service connectors require PRO or MAX',
    );
    expect(systemPrompt.content).toContain('Settings');
    expect(systemPrompt.content).toContain('upgrade');
    expect(systemPrompt.content).not.toContain('connector.');
  });

  it('web.fetch, research.ask, and image.ocr are each rejected OUT_OF_SCOPE before ANY TOOL_INVOCATION reaches the wire', async () => {
    const { processor, transcripts } = makeScriptedProcessor([
      [toolFence('web.fetch', { url: 'https://example.com/?q=exfil' })],
      [toolFence('research.ask', { question: 'What changed this week?' })],
      [toolFence('image.ocr', { folderId: 'fld_1', path: 'scan.png' })],
      ['Understood — those tools are unavailable on this plan.'],
    ]);
    const router = new EnclaveRouter({
      agentLoopProcessorFactory: () => processor,
    });
    const { sessionId, sessionKey, agentTurnId } = await establishSession(router);

    const turn = await runAgentTurn({
      router,
      sessionId,
      sessionKey,
      agentTurnId,
      subscriptionPlanId: 'FREE',
      body: {
        messages: [{ role: 'user', content: 'fetch and research and OCR' }],
        model: 'test-model',
      },
    });

    // The client was NEVER asked to fulfil any of the paid tools.
    expect(turn.toolInvocations).toHaveLength(0);
    // Each attempt is audited as a gateway rejection with OUT_OF_SCOPE.
    const rejected = turn.ledgerEntries.filter(
      (e) => e.outcome === 'gateway_rejected' && e.reason === 'OUT_OF_SCOPE',
    );
    expect(rejected.map((e) => e.toolName)).toEqual([
      'web.fetch',
      'research.ask',
      'image.ocr',
    ]);
    // The model was told the truth (OUT_OF_SCOPE reinjected), and the turn
    // still terminates cleanly rather than hanging.
    expect(allTranscriptText(transcripts)).toContain('OUT_OF_SCOPE');
    expect(turn.doneCount).toBe(1);
  });

  it('control: the SAME web.fetch invocation under PRO is dispatched to the client (FREE rejection is plan-driven)', async () => {
    const { processor } = makeScriptedProcessor([
      [toolFence('web.fetch', { url: 'https://example.com/?q=exfil' })],
      ['Fetched.'],
    ]);
    const router = new EnclaveRouter({
      agentLoopProcessorFactory: () => processor,
    });
    const { sessionId, sessionKey, agentTurnId } = await establishSession(router);

    const turn = await runAgentTurn({
      router,
      sessionId,
      sessionKey,
      agentTurnId,
      subscriptionPlanId: 'PRO',
      body: {
        messages: [{ role: 'user', content: 'fetch it' }],
        model: 'test-model',
      },
      fulfilToolInvocation: () => ({
        url: 'https://example.com/?q=exfil',
        text: 'hello from the web',
      }),
    });

    // PRO: the gateway admits web.fetch — the invocation reaches the wire.
    expect(turn.toolInvocations.map((i) => i.toolName)).toContain('web.fetch');
    expect(
      turn.ledgerEntries.filter((e) => e.reason === 'OUT_OF_SCOPE'),
    ).toHaveLength(0);
  });

  it('a malformed plan id ("ELITE") gets the FREE scope, not a paid one — web.fetch stays OUT_OF_SCOPE', async () => {
    const { processor } = makeScriptedProcessor([
      [toolFence('web.fetch', { url: 'https://example.com/' })],
      ['ok.'],
    ]);
    const router = new EnclaveRouter({
      agentLoopProcessorFactory: () => processor,
    });
    const { sessionId, sessionKey, agentTurnId } = await establishSession(router);

    const turn = await runAgentTurn({
      router,
      sessionId,
      sessionKey,
      agentTurnId,
      subscriptionPlanId: 'ELITE',
      body: {
        messages: [{ role: 'user', content: 'fetch it' }],
        model: 'test-model',
      },
    });

    expect(turn.toolInvocations).toHaveLength(0);
    expect(turn.ledgerEntries).toContainEqual(
      expect.objectContaining({
        toolName: 'web.fetch',
        outcome: 'gateway_rejected',
        reason: 'OUT_OF_SCOPE',
      }),
    );
  });
});

// ─── V3 — per-turn tool-call budget ──────────────────────────────────────────

describe('B4 V3 — FREE tool-call budget is exhausted on the 5th call', () => {
  // A model that NEVER stops calling memory.list (an in-scope FREE tool):
  // a single-element script replays forever.
  const endlessToolScript = [
    [toolFence('memory.list', { namespace: 'default' })],
  ];

  it(`FREE: exactly ${FREE_AGENT_MAX_TOOL_CALLS} calls dispatch, the ${FREE_AGENT_MAX_TOOL_CALLS + 1}th trips TOOL_LIMIT_EXCEEDED`, async () => {
    const { processor } = makeScriptedProcessor(endlessToolScript);
    const router = new EnclaveRouter({
      agentLoopProcessorFactory: () => processor,
    });
    const { sessionId, sessionKey, agentTurnId } = await establishSession(router);

    const turn = await runAgentTurn({
      router,
      sessionId,
      sessionKey,
      agentTurnId,
      subscriptionPlanId: 'FREE',
      body: {
        messages: [{ role: 'user', content: 'list everything forever' }],
        model: 'test-model',
      },
      fulfilToolInvocation: () => ({ records: [] }),
    });

    expect(turn.toolInvocations).toHaveLength(FREE_AGENT_MAX_TOOL_CALLS);
    expect(turn.errors).toContainEqual(
      expect.objectContaining({ error_code: 'TOOL_LIMIT_EXCEEDED' }),
    );
    expect(turn.doneCount).toBe(0);
  });

  it('control: PRO runs 5 tool calls in one turn without exhausting its budget', async () => {
    const fiveCallsThenDone = [
      ...Array.from({ length: 5 }, () => [
        toolFence('memory.list', { namespace: 'default' }),
      ]),
      ['All done.'],
    ];
    const { processor } = makeScriptedProcessor(fiveCallsThenDone);
    const router = new EnclaveRouter({
      agentLoopProcessorFactory: () => processor,
    });
    const { sessionId, sessionKey, agentTurnId } = await establishSession(router);

    const turn = await runAgentTurn({
      router,
      sessionId,
      sessionKey,
      agentTurnId,
      subscriptionPlanId: 'PRO',
      body: {
        messages: [{ role: 'user', content: 'list five times' }],
        model: 'test-model',
      },
      fulfilToolInvocation: () => ({ records: [] }),
    });

    expect(turn.toolInvocations).toHaveLength(5);
    expect(turn.errors).not.toContainEqual(
      expect.objectContaining({ error_code: 'TOOL_LIMIT_EXCEEDED' }),
    );
    expect(turn.doneCount).toBe(1);
  });
});

// ─── V4 — cumulative 256 KiB model-visible read cap ──────────────────────────

describe('B4 V4 — FREE aggregate read bytes are capped at 256 KiB', () => {
  // Two reads, EACH individually under the cap, that together exceed it —
  // proving the accounting is cumulative across the turn, not per-result.
  // tier-a validates every memory.list record against MemoryRecordSchema
  // (text ≤ 8000 chars), so each big read is MANY schema-valid records. The
  // fixture is sized against sanitizeToolOutputForModel — the EXACT
  // model-visible serialisation the gateway's cap accounting measures.
  const READ_ONE_MARKER = 'B4READONE';
  const READ_TWO_MARKER = 'B4READTWO';

  const makeRecord = (marker: string, idx: number) => ({
    id: `m_${marker}_${idx}`,
    namespace: 'default',
    baseVersion: 0,
    tombstoneEpoch: 0,
    dreamSessionId: 'dream_b4',
    kind: 'fact',
    text: `${marker} note ${idx} ${'a'.repeat(7800)}`,
    structured: {},
    tags: [],
    provenance: [
      {
        excerpt: 'note excerpt',
        excerptHash: `sha256:${'a'.repeat(64)}`,
        sourceRef: { type: 'conversation', conversationId: 'c1' },
        extractedAt: '2026-06-01T00:00:00.000Z',
        dreamSessionId: 'dream_b4',
      },
    ],
    confidence: 0.9,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    supersededBy: null,
    visibleToUser: true,
  });

  const modelVisibleBytes = (records: unknown[]): number =>
    Buffer.byteLength(
      sanitizeToolOutputForModel({
        toolName: 'memory.list',
        outcome: 'ok',
        payload: { records },
      }),
      'utf8',
    );

  /** Grow a records list until its model-visible size approaches `targetBytes` (never over). */
  const makeBigListResult = (
    marker: string,
    targetBytes: number,
  ): { records: ReturnType<typeof makeRecord>[] } => {
    const records: ReturnType<typeof makeRecord>[] = [];
    for (let i = 0; i < 200; i += 1) {
      const candidate = [...records, makeRecord(marker, i)];
      if (modelVisibleBytes(candidate) > targetBytes) break;
      records.push(candidate[candidate.length - 1]);
    }
    return { records };
  };

  const perReadTarget = Math.floor(FREE_AGENT_READ_AGGREGATE_BYTES * 0.6);
  const readBodies = [
    makeBigListResult(READ_ONE_MARKER, perReadTarget),
    makeBigListResult(READ_TWO_MARKER, perReadTarget),
  ];

  it('sanity: each read alone is under the cap; both together exceed it', () => {
    const sizes = readBodies.map((body) => modelVisibleBytes(body.records));
    for (const size of sizes) {
      expect(size).toBeLessThan(FREE_AGENT_READ_AGGREGATE_BYTES);
    }
    expect(sizes[0] + sizes[1]).toBeGreaterThan(
      FREE_AGENT_READ_AGGREGATE_BYTES,
    );
  });

  it('FREE: the read that pushes the turn past the cap is rejected TOOL_RESULT_TOO_LARGE and its bytes never reach the model', async () => {
    const { processor, transcripts } = makeScriptedProcessor([
      [toolFence('memory.list', { namespace: 'default' })],
      [toolFence('memory.list', { namespace: 'default' })],
      ['Summarised what I could read.'],
    ]);
    const router = new EnclaveRouter({
      agentLoopProcessorFactory: () => processor,
    });
    const { sessionId, sessionKey, agentTurnId } = await establishSession(router);

    let readIndex = 0;
    const turn = await runAgentTurn({
      router,
      sessionId,
      sessionKey,
      agentTurnId,
      subscriptionPlanId: 'FREE',
      body: {
        messages: [{ role: 'user', content: 'read all my notes' }],
        model: 'test-model',
      },
      fulfilToolInvocation: () => {
        const body = readBodies[Math.min(readIndex, readBodies.length - 1)];
        readIndex += 1;
        return body;
      },
    });

    // Both invocations were dispatched (the cap is on RESULT bytes, not on
    // the right to call an in-scope tool)...
    expect(turn.toolInvocations).toHaveLength(2);
    // ...but the second result is rejected at the gateway choke point.
    const tooLarge = turn.ledgerEntries.filter(
      (e) => e.reason === 'TOOL_RESULT_TOO_LARGE',
    );
    expect(tooLarge).toHaveLength(1);
    expect(tooLarge[0]).toMatchObject({
      toolName: 'memory.list',
      outcome: 'gateway_rejected',
    });
    // The capped payload NEVER enters the model context; the first
    // (under-cap) read did.
    const transcriptText = allTranscriptText(transcripts);
    expect(transcriptText).toContain(READ_ONE_MARKER);
    expect(transcriptText).not.toContain(READ_TWO_MARKER);
    // Capped — not crashed: the turn still completes.
    expect(turn.doneCount).toBe(1);
  });

  it('control: the SAME two reads under PRO both land (no FREE byte cap applied)', async () => {
    const { processor, transcripts } = makeScriptedProcessor([
      [toolFence('memory.list', { namespace: 'default' })],
      [toolFence('memory.list', { namespace: 'default' })],
      ['Read both.'],
    ]);
    const router = new EnclaveRouter({
      agentLoopProcessorFactory: () => processor,
    });
    const { sessionId, sessionKey, agentTurnId } = await establishSession(router);

    let readIndex = 0;
    const turn = await runAgentTurn({
      router,
      sessionId,
      sessionKey,
      agentTurnId,
      subscriptionPlanId: 'PRO',
      body: {
        messages: [{ role: 'user', content: 'read all my notes' }],
        model: 'test-model',
      },
      fulfilToolInvocation: () => {
        const body = readBodies[Math.min(readIndex, readBodies.length - 1)];
        readIndex += 1;
        return body;
      },
    });

    expect(turn.toolInvocations).toHaveLength(2);
    expect(
      turn.ledgerEntries.filter((e) => e.reason === 'TOOL_RESULT_TOO_LARGE'),
    ).toHaveLength(0);
    expect(allTranscriptText(transcripts)).toContain(READ_TWO_MARKER);
    expect(turn.doneCount).toBe(1);
  });
});

// ─── V5 — malformed plan ids fail closed to FREE, never up ───────────────────

describe('B4 V5 — malformed subscription_plan_id defaults to FREE (never up)', () => {
  it.each([
    ['lowercase "pro"', 'pro'],
    ['lowercase "free"', 'free'],
    ['unknown tier "PLATINUM"', 'PLATINUM'],
    ['empty string', ''],
    ['a number', 7],
    ['an object', { plan: 'MAX' }],
    ['null', null],
    ['whitespace-padded " PRO "', ' PRO '],
  ])(
    '%s never grants orchestrator access',
    async (_label, malformedPlanId) => {
      const { processor, transcripts } = makeScriptedProcessor([
        ['should-never-run.'],
      ]);
      const router = new EnclaveRouter({
        agentLoopProcessorFactory: () => processor,
      });
      const { sessionId, sessionKey, agentTurnId } =
        await establishSession(router);

      const turn = await runAgentTurn({
        router,
        sessionId,
        sessionKey,
        agentTurnId,
        subscriptionPlanId: malformedPlanId,
        body: orchestratorCheatBody,
      });

      expect(turn.errors).toContainEqual(
        expect.objectContaining({
          error_code: 'ORCHESTRATOR_REQUIRES_PAID_PLAN',
        }),
      );
      expect(transcripts).toHaveLength(0);
      expect(turn.toolInvocations).toHaveLength(0);
      expect(turn.doneCount).toBe(0);
    },
  );

  it('an OMITTED subscription_plan_id also fails closed to FREE for orchestrator admission', async () => {
    const { processor, transcripts } = makeScriptedProcessor([
      ['should-never-run.'],
    ]);
    const router = new EnclaveRouter({
      agentLoopProcessorFactory: () => processor,
    });
    const { sessionId, sessionKey, agentTurnId } = await establishSession(router);

    const turn = await runAgentTurn({
      router,
      sessionId,
      sessionKey,
      agentTurnId,
      // subscriptionPlanId deliberately not set: the field is absent from
      // the outer envelope entirely.
      body: orchestratorCheatBody,
    });

    expect(turn.errors).toContainEqual(
      expect.objectContaining({ error_code: 'ORCHESTRATOR_REQUIRES_PAID_PLAN' }),
    );
    expect(transcripts).toHaveLength(0);
    expect(turn.doneCount).toBe(0);
  });
});
