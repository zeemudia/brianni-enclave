/**
 * Integration tests for the Phase-3 Layer-3 research-query approval
 * reverse-channel in the live enclave request path (enclave/src/index.ts).
 *
 * What this proves:
 *   1. When a claims orchestrator worker calls research.ask with a CLEAN
 *      question + a valid cross-pack grant for {money}, the enclave emits a
 *      MSG.RESEARCH_QUERY_APPROVAL frame whose decrypted payload contains the
 *      EXACT compiled query string (verbatim) plus an opaque approvalId — and
 *      it is emitted WHILE the orchestrator is suspended inside
 *      gateway.dispatch(research.ask) awaiting approveQuery (the whole point of
 *      the concurrent outQueue restructure: a direct for-await yield could not
 *      emit it).
 *   2. Feeding a MSG.RESEARCH_QUERY_APPROVAL_RESULT(approved:true) into the
 *      SAME router/session resolves the pending approval and the research
 *      delegation PROCEEDS — no RESEARCH_QUERY_DECLINED appears and the turn
 *      reaches AGENT_DONE.
 *   3. The declined variant (approved:false) surfaces RESEARCH_QUERY_DECLINED
 *      on the turn.
 *
 * Concurrency model: the AGENT_REQUEST handleMessage generator is consumed in
 * a background async task that pushes decrypted frames into a shared array as
 * they arrive. A poller waits for the RESEARCH_QUERY_APPROVAL frame, extracts
 * the approvalId, and posts the RESULT via a SEPARATE handleMessage call on the
 * same router (modelling the client's reverse-channel POST landing on a second
 * connection while the AGENT_REQUEST socket is still open). This is exactly the
 * dual-frame interaction the spec asks for.
 *
 * Harness reuses the session bootstrap + encryptToFrame helpers from
 * cross-pack-grant-wiring.test.ts.
 */
import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  compileResearchQuery,
  computeGrantCommitment,
  type ChatChunk,
  type ChatMessage,
  type ChatProcessor,
} from '@calypso/chat-types';

import { EnclaveRouter } from '../index';
import { encodeFrame, MSG } from '../vsock';

const subtle = webcrypto.subtle;

// ─── Session bootstrap (identical to cross-pack-grant-wiring.test.ts) ─────────

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

// ─── A claims orchestrator processor that calls research.ask ──────────────────
//
// One processor serves all three model roles (the router resolves planner,
// worker, and research subagent through the same injected factory):
//   - Planner ("private task planner" in the prompt) → a one-subtask plan whose
//     subtask scopes research.ask.
//   - Worker (claims-advocate system prompt) → emits a single research.ask tool
//     call with the CLEAN structured query, then on the reinjected result emits
//     final prose.
//   - Research subagent ("web researcher" system prompt) → emits a short answer.

const CLEAN_QUERY_ARGS = {
  insurer: 'Aetna',
  question: 'out-of-network ER appeal deadline 2026',
} as const;

// The EXACT string the enclave compiles and must surface for approval.
const EXPECTED_COMPILED_QUERY = compileResearchQuery(CLEAN_QUERY_ARGS);

function makeClaimsResearchProcessor(): ChatProcessor {
  return {
    async *streamChat(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
      const system = messages[0]?.content ?? '';
      const last = messages.at(-1)?.content ?? '';

      // Planner role.
      if (last.includes('private task planner')) {
        const tag = last.match(/<plan id="([^"]+)">/)?.[1] ?? 'planner_claims';
        yield {
          id: 'planner',
          choices: [
            {
              delta: {
                content: `<plan id="${tag}">{
                  "planId": "plan_research",
                  "title": "Research the appeal deadline",
                  "summary": "Look up the public appeal deadline.",
                  "subtasks": [
                    {
                      "id": "st_research",
                      "title": "Research deadline",
                      "objective": "Find the public out-of-network ER appeal deadline.",
                      "kind": "research",
                      "requiredCapabilities": ["research"],
                      "allowedTools": ["research.ask"],
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

      // Research subagent role (air-gapped web-only worker). Discriminate on
      // the START of the RESEARCH_WORKER_PACK system prompt ("You are a web
      // researcher. ...") — the CLAIMS worker prompt also contains the
      // substring "web researcher" elsewhere, so a substring check would
      // mis-route the worker here.
      if (system.startsWith('You are a web researcher')) {
        yield {
          id: 'research',
          choices: [
            {
              delta: {
                content:
                  'Out-of-network ER appeals must be filed within 180 days.',
              },
              finish_reason: 'stop',
            },
          ],
        };
        return;
      }

      // Worker role (claims advocate). On the first call (no research result
      // in context yet) emit a single research.ask tool call; once ANY
      // research.ask result is reinjected — the UNTRUSTED_RESEARCH_RESULT
      // wrapper on approval OR a RESEARCH_QUERY_DECLINED tool-result on
      // decline — emit final prose so the turn completes.
      //
      // IMPORTANT: scan only the NON-system messages (slice(1)). The claims
      // pack's canonical system prompt itself literally contains the strings
      // "UNTRUSTED_RESEARCH_RESULT" and "research.ask" (it instructs the model
      // how to treat them), so scanning messages[0] would always report
      // "already invoked" and the worker would never call research.ask. The
      // agent loop is single-tool-in-flight, so this two-state branch
      // deterministically yields exactly one research.ask per turn (no
      // re-invoke loop on decline).
      const alreadyInvoked = messages
        .slice(1)
        .some(
          (m) =>
            m.content.includes('UNTRUSTED_RESEARCH_RESULT') ||
            m.content.includes('RESEARCH_QUERY_DECLINED'),
        );
      if (!alreadyInvoked) {
        const toolCall = JSON.stringify({
          toolName: 'research.ask',
          args: CLEAN_QUERY_ARGS,
        });
        yield {
          id: 'worker_tool',
          choices: [
            { delta: { content: `<tool>${toolCall}</tool>` }, finish_reason: 'stop' },
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

// ─── Agent-request driver with concurrent reverse-channel ─────────────────────

interface DrivenFrame {
  type: number;
  body: Buffer;
}

function buildClaimsGrantRequest(input: {
  sessionId: string;
  agentTurnId: string;
}): {
  outerEnvelopeBase: Record<string, unknown>;
  encryptedPayload: Record<string, unknown>;
  crossPackGrant: Record<string, unknown>;
} {
  const expiresAt = Date.now() + 60_000;
  const grantBody = {
    namespaces: ['money'],
    folderIds: [],
    documentIds: [],
    nonce: 'nonce-research-approval',
  };
  const commit = computeGrantCommitment(
    grantBody as Parameters<typeof computeGrantCommitment>[0],
    { mode: 'jit', expiresAt },
  );
  const crossPackGrant = {
    grantId: 'grant_research_approval',
    commit,
    healthVerified: false,
    mode: 'jit',
    expiresAt,
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
  const outerEnvelopeBase = {
    session_id: input.sessionId,
    agent_turn_id: input.agentTurnId,
    active_skill_pack_id: 'personal-agent.claims',
    subscription_plan_id: 'PRO',
  };
  return { outerEnvelopeBase, encryptedPayload, crossPackGrant };
}

/**
 * Drive the claims-research AGENT_REQUEST and resolve the approval mid-stream.
 *
 * @param decision  true → approve, false → decline.
 * @param interpose  optional hook invoked AFTER the RESEARCH_QUERY_APPROVAL
 *   frame is captured but BEFORE the legitimate result is posted — used by the
 *   session-binding test to inject a forged result from a different session
 *   during the approval window.
 */
async function driveResearchApproval(input: {
  router: EnclaveRouter;
  sessionId: string;
  sessionKey: webcrypto.CryptoKey;
  agentTurnId: string;
  decision: boolean;
  interpose?: (approvalPayload: {
    approvalId: string;
    turnId: string;
    query: string;
  }) => Promise<void>;
}): Promise<{
  frames: DrivenFrame[];
  approvalPayload: { approvalId: string; turnId: string; query: string };
}> {
  const { router, sessionId, sessionKey, agentTurnId, decision, interpose } =
    input;
  const { outerEnvelopeBase, encryptedPayload, crossPackGrant } =
    buildClaimsGrantRequest({ sessionId, agentTurnId });

  const ciphertext = await encryptToFrame(
    sessionKey,
    Buffer.from(JSON.stringify(encryptedPayload)),
  );
  const outer = {
    ...outerEnvelopeBase,
    cross_pack_grant: crossPackGrant,
    ciphertext: ciphertext.toString('base64'),
  };
  const agentFrame = encodeFrame(
    MSG.AGENT_REQUEST,
    Buffer.from(JSON.stringify(outer)),
  );

  const frames: DrivenFrame[] = [];

  // Consume the AGENT_REQUEST generator in the background.
  const consume = (async () => {
    for await (const out of router.handleMessage(agentFrame)) {
      const b = Buffer.from(out);
      frames.push({ type: b.readUInt8(0), body: b.subarray(5) });
    }
  })();

  // Poll for the RESEARCH_QUERY_APPROVAL frame, then resolve it on a SEPARATE
  // handleMessage call (the reverse channel). This must succeed WHILE the
  // AGENT_REQUEST generator above is still suspended in dispatch.
  let approvalPayload: {
    approvalId: string;
    turnId: string;
    query: string;
  } | null = null;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const approvalFrame = frames.find(
      (f) => f.type === MSG.RESEARCH_QUERY_APPROVAL,
    );
    if (approvalFrame) {
      approvalPayload = (await decryptFrameBody(
        sessionKey,
        approvalFrame.body,
      )) as { approvalId: string; turnId: string; query: string };
      break;
    }
    // Yield to the event loop so the suspended pump/approveQuery can progress.
    await new Promise((r) => setTimeout(r, 5));
  }

  if (!approvalPayload) {
    // Make sure the consumer settles before the test fails.
    await consume;
    throw new Error(
      'RESEARCH_QUERY_APPROVAL frame never emitted; frames seen: ' +
        frames.map((f) => `0x${f.type.toString(16)}`).join(','),
    );
  }

  // Optionally let the test interpose (e.g. a forged cross-session result)
  // while the approval is still pending.
  if (interpose) {
    await interpose(approvalPayload);
  }

  // Post the approval result on the reverse channel.
  const resultCipher = await encryptToFrame(
    sessionKey,
    Buffer.from(
      JSON.stringify({
        approvalId: approvalPayload.approvalId,
        approved: decision,
      }),
    ),
  );
  const resultFrame = encodeFrame(
    MSG.RESEARCH_QUERY_APPROVAL_RESULT,
    Buffer.from(
      JSON.stringify({
        session_id: sessionId,
        ciphertext: resultCipher.toString('base64'),
      }),
    ),
  );
  for await (const _out of router.handleMessage(resultFrame)) {
    // RESEARCH_QUERY_APPROVAL_RESULT yields nothing on the happy path.
    void _out;
  }

  // Let the AGENT_REQUEST turn run to completion.
  await consume;

  return { frames, approvalPayload };
}

// ─── Helpers to interrogate the decrypted frame stream ────────────────────────

async function decryptAllChunks(
  sessionKey: webcrypto.CryptoKey,
  frames: DrivenFrame[],
): Promise<string> {
  const parts: string[] = [];
  for (const f of frames) {
    if (f.type === MSG.CHAT_CHUNK) {
      try {
        parts.push(JSON.stringify(await decryptFrameBody(sessionKey, f.body)));
      } catch {
        // ignore undecryptable frames
      }
    } else if (f.type === MSG.CHAT_ERROR) {
      parts.push(f.body.toString('utf8'));
    }
  }
  return parts.join('\n');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Layer-3 research-query approval reverse-channel (router path)', () => {
  it('emits RESEARCH_QUERY_APPROVAL with the VERBATIM compiled query + approvalId, and approval lets delegation proceed', async () => {
    const router = new EnclaveRouter({
      agentLoopProcessorFactory: makeClaimsResearchProcessor,
      // Keep the approval fail-closed timeout short so a hung test fails fast
      // rather than waiting the default 60s (we resolve well within this).
      invocationTimeoutMs: 3_000,
    });
    const { sessionId, sessionKey, agentTurnId } =
      await establishSession(router);

    const { frames, approvalPayload } = await driveResearchApproval({
      router,
      sessionId,
      sessionKey,
      agentTurnId,
      decision: true,
    });

    // (1) An approval frame was emitted with the EXACT compiled query verbatim.
    expect(approvalPayload.query).toBe(EXPECTED_COMPILED_QUERY);
    expect(approvalPayload.query).toBe('Aetna out-of-network ER appeal deadline 2026');
    expect(typeof approvalPayload.approvalId).toBe('string');
    expect(approvalPayload.approvalId.length).toBeGreaterThan(0);
    // approvalId is namespaced by session + turn.
    expect(approvalPayload.approvalId.startsWith(`${sessionId}:`)).toBe(true);

    // (2) Delegation proceeded: no RESEARCH_QUERY_DECLINED anywhere, and the
    // turn reached AGENT_DONE.
    const transcript = await decryptAllChunks(sessionKey, frames);
    expect(transcript).not.toContain('RESEARCH_QUERY_DECLINED');

    const errorCodes = frames
      .filter((f) => f.type === MSG.CHAT_ERROR)
      .map((f) => JSON.parse(f.body.toString('utf8')).error_code);
    expect(errorCodes).not.toContain('RESEARCH_QUERY_DECLINED');

    const sawDone = frames.some((f) => f.type === MSG.AGENT_DONE);
    expect(sawDone).toBe(true);
  });

  it('declining the approval (approved:false) surfaces RESEARCH_QUERY_DECLINED on the turn', async () => {
    const router = new EnclaveRouter({
      agentLoopProcessorFactory: makeClaimsResearchProcessor,
      invocationTimeoutMs: 3_000,
    });
    const { sessionId, sessionKey, agentTurnId } =
      await establishSession(router);

    const { frames, approvalPayload } = await driveResearchApproval({
      router,
      sessionId,
      sessionKey,
      agentTurnId,
      decision: false,
    });

    // The verbatim query was still surfaced for approval.
    expect(approvalPayload.query).toBe(EXPECTED_COMPILED_QUERY);

    // The declined result must appear somewhere in the turn's tool-result
    // ledger / reinjected content. The tier-research handler returns
    // RESEARCH_QUERY_DECLINED as the reject reason, which rides the ledger
    // CHAT_CHUNK and the reinjected tool-result.
    const transcript = await decryptAllChunks(sessionKey, frames);
    expect(transcript).toContain('RESEARCH_QUERY_DECLINED');
  });

  it('ignores a RESEARCH_QUERY_APPROVAL_RESULT decrypted under a DIFFERENT session than the approvalId (session binding, no error frame)', async () => {
    // P1 finding: sessionId/turnId ride in the PLAINTEXT outer envelope, so a
    // host-colluding attacker holding ANY valid session key (their own
    // account, session B) can read a victim's approvalId namespace and spray
    // forged { approvalId, approved: true } frames — encrypted under THEIR
    // key, with THEIR session_id — during the victim's (session A) approval
    // window. The enclave must bind the result to the decrypting session:
    // B's frame carrying A's approvalId is IGNORED exactly like an unknown
    // id (no resolve, no resolver delete, no CHAT_ERROR), so A's own later
    // decline still wins.
    const router = new EnclaveRouter({
      agentLoopProcessorFactory: makeClaimsResearchProcessor,
      invocationTimeoutMs: 3_000,
    });
    // Victim session A (runs the agent turn) and attacker session B — both
    // legitimately established on the SAME router.
    const a = await establishSession(router);
    const b = await establishSession(router);

    const forgedYieldTypes: number[] = [];
    const { frames, approvalPayload } = await driveResearchApproval({
      router,
      sessionId: a.sessionId,
      sessionKey: a.sessionKey,
      agentTurnId: a.agentTurnId,
      // A's legitimate decision is DECLINE. If the forged cross-session
      // approve below were honoured, the resolver would already be consumed
      // (approved) and the decline would find nothing — research would
      // proceed and RESEARCH_QUERY_DECLINED would never appear.
      decision: false,
      interpose: async (pending) => {
        // Forge: a VALID encrypted result frame from session B carrying
        // session A's approvalId, approved:true.
        const forgedCipher = await encryptToFrame(
          b.sessionKey,
          Buffer.from(
            JSON.stringify({ approvalId: pending.approvalId, approved: true }),
          ),
        );
        const forgedFrame = encodeFrame(
          MSG.RESEARCH_QUERY_APPROVAL_RESULT,
          Buffer.from(
            JSON.stringify({
              session_id: b.sessionId,
              ciphertext: forgedCipher.toString('base64'),
            }),
          ),
        );
        for await (const out of router.handleMessage(forgedFrame)) {
          forgedYieldTypes.push(Buffer.from(out).readUInt8(0));
        }
      },
    });

    // The forged frame targeted A's approval namespace.
    expect(approvalPayload.approvalId.startsWith(`${a.sessionId}:`)).toBe(true);
    expect(approvalPayload.approvalId.startsWith(`${b.sessionId}:`)).toBe(
      false,
    );

    // Mismatch must be ignored EXACTLY like an unknown approvalId: silent —
    // no CHAT_ERROR, no frames at all (a stale/duplicate result must not
    // error the connection).
    expect(forgedYieldTypes).toEqual([]);

    // A's pending resolver survived the forgery and A's own decline resolved
    // it: the turn surfaces RESEARCH_QUERY_DECLINED (i.e. the forged
    // cross-session approve did NOT auto-approve the research query).
    const transcript = await decryptAllChunks(a.sessionKey, frames);
    expect(transcript).toContain('RESEARCH_QUERY_DECLINED');
  });
});
