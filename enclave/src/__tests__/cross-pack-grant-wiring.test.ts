/**
 * Integration tests for Task 1C.4: cross-pack grant wiring in the live
 * enclave request path (enclave/src/index.ts).
 *
 * Modelled on agent-orchestrator-wire.test.ts — reuses the same
 * handshake/session-key establishment, encryptToFrame helper, and
 * EnclaveRouter construction pattern.
 */
import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  computeGrantCommitment,
  type ChatChunk,
  type ChatMessage,
  type ChatProcessor,
} from '@calypso/chat-types';

import { EnclaveRouter } from '../index';
import { encodeFrame, MSG } from '../vsock';

const subtle = webcrypto.subtle;

// ─── Session bootstrap (identical to agent-orchestrator-wire.test.ts) ─────────

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
  for await (const out of router.handleMessage(attestFrame)) attestResp = Buffer.from(out);
  expect(attestResp).not.toBeNull();
  const attestPayload = JSON.parse(attestResp!.subarray(5).toString('utf8'));
  const teePubKeyB64 = attestPayload.ephemeral_public_key;

  const clientKp = await subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const clientPubRaw = new Uint8Array(await subtle.exportKey('raw', clientKp.publicKey));
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
  for await (const out of router.handleMessage(kxFrame)) kxResp = Buffer.from(out);
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
  const hkdfKey = await subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveBits']);
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

async function encryptToFrame(key: webcrypto.CryptoKey, buf: Buffer): Promise<Buffer> {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new Uint8Array(buf));
  return Buffer.concat([Buffer.from(iv), Buffer.from(ct)]);
}

// ─── Agent request helper ─────────────────────────────────────────────────────

async function sendAgentRequest(input: {
  router: EnclaveRouter;
  sessionId: string;
  sessionKey: webcrypto.CryptoKey;
  agentTurnId: string;
  /** Pack id placed in the OUTER plaintext envelope (server-authoritative). */
  activeSkillPackId: string;
  /** Body placed in the ENCRYPTED inner ciphertext. */
  encryptedPayload: Record<string, unknown>;
  /** Outer (plaintext) cross_pack_grant envelope (server-authoritative). */
  crossPackGrant?: Record<string, unknown>;
  subscriptionPlanId?: 'FREE' | 'PRO' | 'MAX';
}): Promise<Array<{ type: number; body: Buffer }>> {
  const ciphertext = await encryptToFrame(
    input.sessionKey,
    Buffer.from(JSON.stringify(input.encryptedPayload)),
  );
  const outerEnvelope: Record<string, unknown> = {
    session_id: input.sessionId,
    agent_turn_id: input.agentTurnId,
    active_skill_pack_id: input.activeSkillPackId,
    ...(input.subscriptionPlanId ? { subscription_plan_id: input.subscriptionPlanId } : {}),
    ...(input.crossPackGrant ? { cross_pack_grant: input.crossPackGrant } : {}),
    ciphertext: ciphertext.toString('base64'),
  };
  const frame = encodeFrame(MSG.AGENT_REQUEST, Buffer.from(JSON.stringify(outerEnvelope)));
  const outFrames: Array<{ type: number; body: Buffer }> = [];
  for await (const out of input.router.handleMessage(frame)) {
    const b = Buffer.from(out);
    outFrames.push({ type: b.readUInt8(0), body: b.subarray(5) });
  }
  return outFrames;
}

// ─── A minimal orchestrator-capable processor ────────────────────────────────

function makeOrchestratorProcessor(): ChatProcessor {
  return {
    async *streamChat(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
      const last = messages.at(-1)?.content ?? '';
      if (last.includes('private task planner')) {
        const tag = last.match(/<plan id="([^"]+)">/)?.[1] ?? 'planner_claims';
        yield {
          id: 'planner',
          choices: [
            {
              delta: {
                content: `<plan id="${tag}">{
                  "planId": "plan_claims",
                  "title": "Claims letter",
                  "summary": "Draft the claims letter.",
                  "subtasks": [
                    {
                      "id": "st_1",
                      "title": "Draft",
                      "objective": "Draft the claims letter.",
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
        choices: [{ delta: { content: 'Letter draft complete.' }, finish_reason: null }],
      };
    },
  };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('cross-pack grant wiring', () => {
  /**
   * Required test #1: claims pack in single mode → CLAIMS_REQUIRES_ORCHESTRATOR.
   *
   * The claims pack MUST run in orchestrator mode (isolated subtask egress).
   * Single mode merges reads + egress in one model context, opening the
   * read→egress exfil vector for cross-namespace data.
   */
  it('rejects claims pack in single mode with CLAIMS_REQUIRES_ORCHESTRATOR', async () => {
    const router = new EnclaveRouter({ agentLoopProcessorFactory: makeOrchestratorProcessor });
    const { sessionId, sessionKey, agentTurnId } = await establishSession(router);

    const outFrames = await sendAgentRequest({
      router,
      sessionId,
      sessionKey,
      agentTurnId,
      activeSkillPackId: 'personal-agent.claims',
      subscriptionPlanId: 'PRO',
      // No runMode → defaults to "single"
      encryptedPayload: {
        messages: [{ role: 'user', content: 'Help me dispute my medical bill.' }],
        model: 'auto',
      },
    });

    const errors = outFrames
      .filter((f) => f.type === MSG.CHAT_ERROR)
      .map((f) => JSON.parse(f.body.toString('utf8')));

    expect(errors).toContainEqual(
      expect.objectContaining({ error_code: 'CLAIMS_REQUIRES_ORCHESTRATOR' }),
    );
  });

  /**
   * Required test #1 variant: claims pack in single mode is rejected with
   * CLAIMS_REQUIRES_ORCHESTRATOR regardless of subscription plan.
   *
   * The mode gate fires before the plan gate, so a FREE user gets the same
   * error as a PRO user when runMode is absent/single.
   */
  it('rejects claims pack in single mode with CLAIMS_REQUIRES_ORCHESTRATOR regardless of subscription plan', async () => {
    const router = new EnclaveRouter({ agentLoopProcessorFactory: makeOrchestratorProcessor });
    const { sessionId, sessionKey, agentTurnId } = await establishSession(router);

    const outFrames = await sendAgentRequest({
      router,
      sessionId,
      sessionKey,
      agentTurnId,
      activeSkillPackId: 'personal-agent.claims',
      subscriptionPlanId: 'FREE',
      encryptedPayload: {
        messages: [{ role: 'user', content: 'Help me dispute my medical bill.' }],
        model: 'auto',
      },
    });

    const errors = outFrames
      .filter((f) => f.type === MSG.CHAT_ERROR)
      .map((f) => JSON.parse(f.body.toString('utf8')));

    expect(errors).toContainEqual(
      expect.objectContaining({ error_code: 'CLAIMS_REQUIRES_ORCHESTRATOR' }),
    );
  });

  /**
   * Gate interaction: claims pack + orchestrator mode + FREE plan →
   * ORCHESTRATOR_REQUIRES_PAID_PLAN.
   *
   * This is the complementary case to the single-mode tests above and documents
   * the two-gate funnel that blocks FREE users from the claims pack entirely:
   *   single mode  → CLAIMS_REQUIRES_ORCHESTRATOR  (mode gate, fires first)
   *   orchestrator + FREE → ORCHESTRATOR_REQUIRES_PAID_PLAN  (plan gate)
   * No cross_pack_grant is needed — the plan gate fires before grant resolution.
   */
  it('rejects FREE plan in orchestrator mode with ORCHESTRATOR_REQUIRES_PAID_PLAN', async () => {
    const router = new EnclaveRouter({ agentLoopProcessorFactory: makeOrchestratorProcessor });
    const { sessionId, sessionKey, agentTurnId } = await establishSession(router);

    const outFrames = await sendAgentRequest({
      router,
      sessionId,
      sessionKey,
      agentTurnId,
      activeSkillPackId: 'personal-agent.claims',
      subscriptionPlanId: 'FREE',
      encryptedPayload: {
        messages: [{ role: 'user', content: 'Help me dispute my medical bill.' }],
        model: 'auto',
        runMode: 'orchestrator',
        orchestrator: {
          runMode: 'orchestrator',
          policyVersion: 'calypso-orchestrator-v1',
          preferredModelId: 'auto',
          clientCapabilities: { supportsPlanEvents: true, supportsBackgroundResume: false },
        },
      },
    });

    const errors = outFrames
      .filter((f) => f.type === MSG.CHAT_ERROR)
      .map((f) => JSON.parse(f.body.toString('utf8')));

    expect(errors).toContainEqual(
      expect.objectContaining({ error_code: 'ORCHESTRATOR_REQUIRES_PAID_PLAN' }),
    );
  });

  /**
   * Required test #2: claims + orchestrator + WRONG commit → GRANT_COMMITMENT_MISMATCH.
   *
   * The outer envelope has a commit of '0'.repeat(64) which cannot match the
   * actual hash of the inner body.
   */
  it('rejects claims orchestrator request with mismatched grant commit', async () => {
    const router = new EnclaveRouter({ agentLoopProcessorFactory: makeOrchestratorProcessor });
    const { sessionId, sessionKey, agentTurnId } = await establishSession(router);

    const grantBody = {
      namespaces: ['money'],
      folderIds: [],
      documentIds: [],
      nonce: 'nonce-abcd',
    };
    const badCommit = '0'.repeat(64);
    const futureExpiresAt = Date.now() + 60_000;

    const outerGrant = {
      grantId: 'grant_test_1',
      commit: badCommit,
      healthVerified: true,
      mode: 'jit',
      expiresAt: futureExpiresAt,
    };

    const outFrames = await sendAgentRequest({
      router,
      sessionId,
      sessionKey,
      agentTurnId,
      activeSkillPackId: 'personal-agent.claims',
      subscriptionPlanId: 'PRO',
      crossPackGrant: outerGrant,
      encryptedPayload: {
        messages: [{ role: 'user', content: 'Help me dispute my medical bill.' }],
        model: 'auto',
        runMode: 'orchestrator',
        orchestrator: {
          runMode: 'orchestrator',
          policyVersion: 'calypso-orchestrator-v1',
          preferredModelId: 'auto',
          clientCapabilities: { supportsPlanEvents: true, supportsBackgroundResume: false },
        },
        cross_pack_grant_body: grantBody,
      },
    });

    const errors = outFrames
      .filter((f) => f.type === MSG.CHAT_ERROR)
      .map((f) => JSON.parse(f.body.toString('utf8')));

    expect(errors).toContainEqual(
      expect.objectContaining({ error_code: 'GRANT_COMMITMENT_MISMATCH' }),
    );
  });

  /**
   * Desired test #3: claims + orchestrator + VALID grant for {money} → grant is accepted,
   * no GRANT_* or CLAIMS_* error is emitted, and the turn proceeds to planning.
   *
   * Form chosen: assert that NO error_code starting with "GRANT_" or "CLAIMS_" is
   * emitted (i.e. the grant was accepted and the turn proceeded to planning).
   * Rationale: driving a full memory.read for namespace "money" would require
   * wiring a real memory backend into the test harness — that's substantially
   * heavier than what the model test's injected processor provides. The
   * processor path proceeds to emit orchestrator_plan / orchestrator_text chunks
   * after grant resolution, which is sufficient to confirm the grant was accepted.
   */
  it('accepts valid claims grant for {money} and proceeds past grant resolution', async () => {
    const router = new EnclaveRouter({ agentLoopProcessorFactory: makeOrchestratorProcessor });
    const { sessionId, sessionKey, agentTurnId } = await establishSession(router);

    const futureExpiresAt = Date.now() + 60_000;
    const grantBody = {
      namespaces: ['money'],
      folderIds: [],
      documentIds: [],
      nonce: 'nonce-valid-test',
    };
    const commit = computeGrantCommitment(
      grantBody as Parameters<typeof computeGrantCommitment>[0],
      { mode: 'jit', expiresAt: futureExpiresAt },
    );

    const outerGrant = {
      grantId: 'grant_test_2',
      commit,
      healthVerified: false,
      mode: 'jit',
      expiresAt: futureExpiresAt,
    };

    const outFrames = await sendAgentRequest({
      router,
      sessionId,
      sessionKey,
      agentTurnId,
      activeSkillPackId: 'personal-agent.claims',
      subscriptionPlanId: 'PRO',
      crossPackGrant: outerGrant,
      encryptedPayload: {
        messages: [{ role: 'user', content: 'Help me dispute my bill.' }],
        model: 'auto',
        runMode: 'orchestrator',
        orchestrator: {
          runMode: 'orchestrator',
          policyVersion: 'calypso-orchestrator-v1',
          preferredModelId: 'auto',
          clientCapabilities: { supportsPlanEvents: true, supportsBackgroundResume: false },
        },
        cross_pack_grant_body: grantBody,
      },
    });

    // No GRANT_* or CLAIMS_* error should be emitted — the grant was accepted.
    const errors = outFrames
      .filter((f) => f.type === MSG.CHAT_ERROR)
      .map((f) => JSON.parse(f.body.toString('utf8')));
    const grantOrClaimsErrors = errors.filter(
      (e: { error_code?: string }) =>
        typeof e.error_code === 'string' &&
        (e.error_code.startsWith('GRANT_') || e.error_code.startsWith('CLAIMS_')),
    );
    expect(grantOrClaimsErrors).toHaveLength(0);

    // The turn should have proceeded to planning (orchestrator_plan chunk present).
    // We don't decrypt here to keep the test light; the absence of any grant/claims
    // error and the presence of CHAT_CHUNK frames is the signal.
    const chatChunks = outFrames.filter((f) => f.type === MSG.CHAT_CHUNK);
    expect(chatChunks.length).toBeGreaterThan(0);
  });

  /**
   * FIX C: present-but-malformed grant envelope → GRANT_ENVELOPE_INVALID.
   *
   * A tampered or corrupt envelope must NOT silently downgrade to the no-grant
   * (single-namespace) path. A present-but-invalid envelope must emit a
   * deterministic CHAT_ERROR with error_code "GRANT_ENVELOPE_INVALID".
   *
   * The malformed envelope below has a commit that fails the 64-hex regex
   * ("not-64-hex"), which is enough to fail CrossPackGrantEnvelopeSchema.
   */
  it('rejects a present-but-malformed grant envelope with GRANT_ENVELOPE_INVALID', async () => {
    const router = new EnclaveRouter({ agentLoopProcessorFactory: makeOrchestratorProcessor });
    const { sessionId, sessionKey, agentTurnId } = await establishSession(router);

    const malformedGrant = {
      grantId: 'g',
      commit: 'not-64-hex', // fails the /^[0-9a-f]{64}$/ regex
      healthVerified: true,
      mode: 'jit',
      expiresAt: Date.now() + 60_000,
    };

    const outFrames = await sendAgentRequest({
      router,
      sessionId,
      sessionKey,
      agentTurnId,
      activeSkillPackId: 'personal-agent.claims',
      subscriptionPlanId: 'PRO',
      crossPackGrant: malformedGrant,
      encryptedPayload: {
        messages: [{ role: 'user', content: 'Help me dispute my medical bill.' }],
        model: 'auto',
        runMode: 'orchestrator',
        orchestrator: {
          runMode: 'orchestrator',
          policyVersion: 'calypso-orchestrator-v1',
          preferredModelId: 'auto',
          clientCapabilities: { supportsPlanEvents: true, supportsBackgroundResume: false },
        },
      },
    });

    const errors = outFrames
      .filter((f) => f.type === MSG.CHAT_ERROR)
      .map((f) => JSON.parse(f.body.toString('utf8')));

    expect(errors).toContainEqual(
      expect.objectContaining({ error_code: 'GRANT_ENVELOPE_INVALID' }),
    );
  });

  /**
   * Regression: non-claims pack with no grant should still work normally
   * (single-namespace default path unaffected).
   */
  it('does not regress ordinary default-pack requests (no grant, no widening)', async () => {
    const router = new EnclaveRouter({ agentLoopProcessorFactory: makeOrchestratorProcessor });
    const { sessionId, sessionKey, agentTurnId } = await establishSession(router);

    const outFrames = await sendAgentRequest({
      router,
      sessionId,
      sessionKey,
      agentTurnId,
      activeSkillPackId: 'personal-agent.default',
      encryptedPayload: {
        messages: [{ role: 'user', content: 'hi' }],
        model: 'auto',
      },
    });

    // No CHAT_ERROR should be emitted.
    const errors = outFrames.filter((f) => f.type === MSG.CHAT_ERROR);
    expect(errors).toHaveLength(0);

    // Chat response should be present.
    const chatChunks = outFrames.filter((f) => f.type === MSG.CHAT_CHUNK);
    expect(chatChunks.length).toBeGreaterThan(0);
  });
});
