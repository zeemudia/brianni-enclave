import { createHash, webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  ChatChunk,
  ChatMessage,
  ChatProcessor,
  MediaProvenanceRecord,
  ModelCapability,
} from '@calypso/chat-types';

import { EnclaveRouter } from '../index';
import { encodeFrame, MSG } from '../vsock';

const subtle = webcrypto.subtle;

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
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new Uint8Array(buf));
  return Buffer.concat([Buffer.from(iv), Buffer.from(ct)]);
}

async function decryptFromFrame(
  key: webcrypto.CryptoKey,
  body: Buffer,
): Promise<Buffer> {
  const iv = new Uint8Array(body.subarray(0, 12));
  const ct = body.subarray(12);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv }, key, new Uint8Array(ct));
  return Buffer.from(pt);
}

function makeProcessor(): ChatProcessor {
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
                  "planId": "plan_model_supplied",
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

function makeVideoPlanner(): ChatProcessor {
  return {
    async *streamChat(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
      const last = messages.at(-1)?.content ?? '';
      if (last.includes('private task planner')) {
        const tag = last.match(/<plan id="([^"]+)">/)?.[1] ?? 'planner_video';
        yield {
          id: 'planner',
          choices: [
            {
              delta: {
                content: `<plan id="${tag}">{
                  "planId": "plan_video",
                  "title": "Launch video",
                  "summary": "Generate one encrypted video artifact.",
                  "subtasks": [
                    {
                      "id": "clip-1",
                      "title": "Generate teaser",
                      "objective": "Create an 8 second teaser.",
                      "kind": "video",
                      "requiredCapabilities": ["video_generation"],
                      "allowedTools": ["video.generate"],
                      "dependsOn": [],
                      "producesArtifact": true,
                      "risk": "medium",
                      "media": {
                        "operation": "video_generate",
                        "expectedArtifactKind": "video/mp4",
                        "maxDurationSeconds": 8,
                        "privacyPolicy": "sanitized_only"
                      }
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
        choices: [{ delta: { content: 'unused' }, finish_reason: null }],
      };
    },
  };
}

const videoModel: ModelCapability = {
  modelId: 'veo-test',
  providerId: 'google',
  strengths: ['video_generation'],
  strengthQuality: [{ strength: 'video_generation', tier: 'frontier' }],
  modalities: ['text_in', 'image_in', 'video_out'],
  endpointFamily: 'video',
  costTier: 'high',
  latencyTier: 'slow',
  routingStatus: 'enabled',
  requiredGatewayTools: ['video.generate'],
};

const promptBytes = new TextEncoder().encode('Generate an 8 second teaser');
const promptRecord: MediaProvenanceRecord = {
  handleId: 'mh_prompt',
  kind: 'text',
  origin: 'generated',
  providerVisible: false,
  sourceHandleIds: [],
  createdBy: 'test',
  createdAt: '2026-05-19T08:00:00.000Z',
  ttlSeconds: 900,
  byteSize: promptBytes.byteLength,
  sha256: createHash('sha256').update(promptBytes).digest('hex'),
  signature: 'sig',
};

const mediaDeps = {
  videoAdapters: {
    google: {
      start: async () => ({ providerJobId: 'op-video-1' }),
      poll: async () =>
        ({
          status: 'done',
          videoBytes: new TextEncoder().encode('mp4'),
          mimeType: 'video/mp4',
          actualQuotaUnits: 200,
          billingSource: 'provider_operation_metadata',
        }) as const,
    },
  },
  checkpointClient: {
    load: async () => null,
    savePendingStart: async () => undefined,
    saveProviderJob: async () => undefined,
    markCancelled: async () => undefined,
    markBillingPending: async () => undefined,
    listCancelledPending: async () => [],
    listBillingPending: async () => [],
    markBillingSlaEscalated: async () => undefined,
    markTerminal: async () => undefined,
  },
  budgetClient: {
    reserve: async () => ({ ok: true, holdId: 'hold_1' }) as const,
    reconcile: async () => undefined,
  },
  handleStore: {
    getBytes: async (handleId: string) => (handleId === 'mh_prompt' ? promptBytes : null),
    getText: async (handleId: string) =>
      handleId === 'mh_prompt' ? 'Generate an 8 second teaser' : null,
  },
  provenanceSigner: { sign: () => 'sig', verify: () => true },
  consentVerifier: { verify: async () => true },
  resolveProviderInput: async () => ({
    promptHandleId: 'mh_prompt',
    inputHandleIds: [],
    enclaveNonce: 'nonce_1234567890123456',
    pinnedSignerKeyId: 'device_key_1',
    revokedSignerKeyIds: new Set<string>(),
    seenConsentIds: new Set<string>(),
  }),
  resolveRecords: async () => new Map([[promptRecord.handleId, promptRecord]]),
  encryptArtifact: async (input: { bytes: Uint8Array }) => ({
    artifactId: 'artifact_video_1',
    ciphertextRef: 'blob_video_1',
    sha256: createHash('sha256').update(input.bytes).digest('hex'),
    byteSize: input.bytes.byteLength,
  }),
  // Pin the clock 30s past `promptRecord.createdAt` so the 900s TTL doesn't
  // expire mid-test once wall-clock advances past 08:15:00 UTC on 2026-05-19.
  now: new Date('2026-05-19T08:00:30.000Z'),
};

async function sendAgentRequest(input: {
  router: EnclaveRouter;
  sessionId: string;
  sessionKey: webcrypto.CryptoKey;
  agentTurnId: string;
  encryptedPayload: Record<string, unknown>;
  subscriptionPlanId?: 'FREE' | 'PRO' | 'MAX';
}): Promise<Array<{ type: number; body: Buffer }>> {
  const ciphertext = await encryptToFrame(
    input.sessionKey,
    Buffer.from(JSON.stringify(input.encryptedPayload)),
  );
  const outerEnvelope = {
    session_id: input.sessionId,
    agent_turn_id: input.agentTurnId,
    active_skill_pack_id: 'personal-agent.default',
    ...(input.subscriptionPlanId
      ? { subscription_plan_id: input.subscriptionPlanId }
      : {}),
    ciphertext: ciphertext.toString('base64'),
  };
  expect(JSON.stringify(outerEnvelope)).not.toContain('Application materials');
  expect(JSON.stringify(outerEnvelope)).not.toContain('st_1');
  expect(JSON.stringify(outerEnvelope)).not.toContain('runMode');

  const frame = encodeFrame(
    MSG.AGENT_REQUEST,
    Buffer.from(JSON.stringify(outerEnvelope)),
  );
  const outFrames: Array<{ type: number; body: Buffer }> = [];
  for await (const out of input.router.handleMessage(frame)) {
    const b = Buffer.from(out);
    outFrames.push({ type: b.readUInt8(0), body: b.subarray(5) });
  }
  return outFrames;
}

describe('EnclaveRouter orchestrator wire mode', () => {
  it('keeps ordinary agent requests on the single-loop path', async () => {
    const router = new EnclaveRouter({ agentLoopProcessorFactory: makeProcessor });
    const { sessionId, sessionKey, agentTurnId } = await establishSession(router);

    const outFrames = await sendAgentRequest({
      router,
      sessionId,
      sessionKey,
      agentTurnId,
      encryptedPayload: {
        messages: [{ role: 'user', content: 'hi' }],
        model: 'gpt-5.5',
      },
    });

    const decodedChunks = await Promise.all(
      outFrames
        .filter((frame) => frame.type === MSG.CHAT_CHUNK)
        .map((frame) =>
          decryptFromFrame(sessionKey, frame.body).then((buf) =>
            JSON.parse(buf.toString('utf8')),
          ),
        ),
    );
    expect(decodedChunks).toContainEqual({ text: 'Draft complete.' });
    expect(decodedChunks.some((chunk) => chunk._type === 'orchestrator_plan')).toBe(
      false,
    );
  });

  it('routes encrypted orchestrator mode to plan/progress chunks', async () => {
    const router = new EnclaveRouter({ agentLoopProcessorFactory: makeProcessor });
    const { sessionId, sessionKey, agentTurnId } = await establishSession(router);

    const outFrames = await sendAgentRequest({
      router,
      sessionId,
      sessionKey,
      agentTurnId,
      subscriptionPlanId: 'PRO',
      encryptedPayload: {
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
      },
    });

    const decodedChunks = await Promise.all(
      outFrames
        .filter((frame) => frame.type === MSG.CHAT_CHUNK)
        .map((frame) =>
          decryptFromFrame(sessionKey, frame.body).then((buf) =>
            JSON.parse(buf.toString('utf8')),
          ),
        ),
    );

    expect(decodedChunks).toContainEqual(
      expect.objectContaining({
        _type: 'orchestrator_plan',
        plan: expect.objectContaining({ title: 'Application materials' }),
      }),
    );
    expect(decodedChunks).toContainEqual(
      expect.objectContaining({
        _type: 'orchestrator_text',
        text: 'Draft complete.',
      }),
    );
  });

  it('rejects encrypted orchestrator mode for FREE before any provider call', async () => {
    const processor = makeProcessor();
    const streamSpy = vi.spyOn(processor, 'streamChat');
    const router = new EnclaveRouter({ agentLoopProcessorFactory: () => processor });
    const { sessionId, sessionKey, agentTurnId } = await establishSession(router);

    const outFrames = await sendAgentRequest({
      router,
      sessionId,
      sessionKey,
      agentTurnId,
      subscriptionPlanId: 'FREE',
      encryptedPayload: {
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
      },
    });

    const errors = outFrames
      .filter((frame) => frame.type === MSG.CHAT_ERROR)
      .map((frame) => JSON.parse(frame.body.toString('utf8')));
    expect(errors).toContainEqual(
      expect.objectContaining({
        error_code: 'ORCHESTRATOR_REQUIRES_PAID_PLAN',
      }),
    );
    expect(streamSpy).not.toHaveBeenCalled();
  });

  it('routes a video-generation subtask through the deterministic shaper when the pack scopes video.generate and media is wired (finding 18)', async () => {
    const router = new EnclaveRouter({
      agentLoopProcessorFactory: makeVideoPlanner,
      media: mediaDeps,
      orchestratorModels: [
        {
          modelId: 'gpt-5.5',
          providerId: 'openai',
          strengths: ['planning', 'writing', 'general_reasoning'],
          strengthQuality: [{ strength: 'planning', tier: 'frontier' }],
          modalities: ['text_in', 'text_out'],
          endpointFamily: 'chat',
          costTier: 'high',
          latencyTier: 'standard',
          routingStatus: 'enabled',
          requiredGatewayTools: [],
        },
        videoModel,
      ],
    } as never);
    const { sessionId, sessionKey, agentTurnId } = await establishSession(router);

    const outFrames = await sendAgentRequest({
      router,
      sessionId,
      sessionKey,
      agentTurnId,
      subscriptionPlanId: 'PRO',
      encryptedPayload: {
        messages: [{ role: 'user', content: 'Make a short product teaser video.' }],
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
      },
    });

    const decodedChunks = await Promise.all(
      outFrames
        .filter((frame) => frame.type === MSG.CHAT_CHUNK)
        .map((frame) =>
          decryptFromFrame(sessionKey, frame.body).then((buf) =>
            JSON.parse(buf.toString('utf8')),
          ),
        ),
    );

    // Finding 18: the General pack now scopes video.generate, so a "make me a
    // video" GENERATION request — with a routable video model + wired media — is
    // shaped by createTaskPlan's DETERMINISTIC media-gen shaper into a real
    // kind:'video' subtask using video.generate. The short-circuit runs BEFORE
    // the LLM planner, so the injected planner's 'clip-1' plan is never consulted
    // (the determinism that prevents the R5 fake-SVG/storyboard substitute).
    expect(decodedChunks).toContainEqual(
      expect.objectContaining({
        _type: 'orchestrator_plan',
        plan: expect.objectContaining({
          title: 'Generate video',
          subtasks: expect.arrayContaining([
            expect.objectContaining({
              id: 'st_video',
              kind: 'video',
              allowedTools: expect.arrayContaining(['video.generate']),
              media: expect.objectContaining({ operation: 'video_generate' }),
            }),
          ]),
        }),
      }),
    );
    // The deterministic shaper is authoritative: the injected LLM planner's plan
    // ('clip-1' / "Launch video") is bypassed entirely.
    expect(JSON.stringify(decodedChunks)).not.toContain('clip-1');
    expect(JSON.stringify(decodedChunks)).not.toContain('Launch video');
    // Coverage net: binary delivery is UNWIRED here (mediaDeps has no
    // awaitBinaryWriteAck/binaryWorkItems), so the routed video subtask reaches
    // the media executor and stops cleanly at the delivery step — no
    // binary_work_item.write_request is emitted (no bytes leak to the client).
    expect(JSON.stringify(decodedChunks)).toContain(
      'VIDEO_GENERATE_DELIVERY_UNAVAILABLE',
    );
    expect(JSON.stringify(decodedChunks)).not.toContain(
      'binary_work_item.write_request',
    );
  });
});
