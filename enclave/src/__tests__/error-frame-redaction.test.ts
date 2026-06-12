/**
 * Error-handling audit H1/M2/M3 — frame-boundary redaction.
 *
 * Every UNENCRYPTED error frame the enclave emits is host-visible, so it
 * must carry an allowlisted, opaque error_code ONLY — never err.message
 * (which can embed decrypted/derived content: JSON.parse source snippets,
 * client role values, Zod issue text, provider SDK errors).
 *
 * Each handler test injects an error whose message contains a sentinel and
 * asserts the outbound frame does NOT contain it.
 */
import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MSG } from "@calypso/chat-types";
import { encryptChunk } from "../crypto";
import { decodeFrame, encodeFrame } from "../vsock";

const subtle = webcrypto.subtle;
const SENTINEL = "SENSITIVE_SENTINEL_7f3a";

vi.mock("../providers/registry", () => ({
  initRegistry: vi.fn(),
  getProviderForCustomModel: vi.fn(),
  getProviderForModel: vi.fn().mockReturnValue({
    provider: {
      id: "openai",
      adapter: "openai_v1",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnvVar: "OPENAI_API_KEY",
      models: [{ id: "gpt-4o", displayName: "GPT-4o" }],
    },
    model: { id: "gpt-4o", displayName: "GPT-4o" },
  }),
  createProcessor: vi.fn().mockReturnValue({
    streamChat: async function* () {
      yield {
        id: "test",
        choices: [{ delta: { content: "Hi" }, finish_reason: null }],
      };
      yield { id: "test", choices: [{ delta: {}, finish_reason: "stop" }] };
    },
  }),
  getAllProviders: vi.fn().mockReturnValue([
    {
      id: "openai",
      adapter: "openai_v1",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnvVar: "OPENAI_API_KEY",
      models: [{ id: "gpt-4o", displayName: "GPT-4o" }],
    },
  ]),
}));

async function setupSession(router: any, sessionId: string) {
  const nonce = webcrypto.getRandomValues(new Uint8Array(32));
  const attestReq = encodeFrame(
    MSG.ATTESTATION_REQUEST,
    Buffer.from(
      JSON.stringify({ nonce: Buffer.from(nonce).toString("base64") }),
    ),
  );
  let attestResp: Buffer | undefined;
  for await (const frame of router.handleMessage(attestReq)) attestResp = frame;
  const attestPayload = JSON.parse(decodeFrame(attestResp!).payload.toString());

  const clientKP = await subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const clientPubRaw = Buffer.from(
    await subtle.exportKey("raw", clientKP.publicKey),
  );
  const clientNonce = webcrypto.getRandomValues(new Uint8Array(32));

  const kxReq = encodeFrame(
    MSG.KEY_EXCHANGE,
    Buffer.from(
      JSON.stringify({
        client_ephemeral_public_key: clientPubRaw.toString("base64"),
        session_id: sessionId,
        client_key_exchange_nonce: Buffer.from(clientNonce).toString("base64"),
        tee_public_key: attestPayload.ephemeral_public_key,
      }),
    ),
  );
  let kxResp: Buffer | undefined;
  for await (const frame of router.handleMessage(kxReq)) kxResp = frame;
  const kxPayload = JSON.parse(decodeFrame(kxResp!).payload.toString());

  const teePubKey = await subtle.importKey(
    "raw",
    Buffer.from(attestPayload.ephemeral_public_key, "base64"),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sharedBits = await subtle.deriveBits(
    { name: "ECDH", public: teePubKey },
    clientKP.privateKey,
    256,
  );
  const salt = new Uint8Array(64);
  salt.set(clientNonce, 0);
  salt.set(Buffer.from(kxPayload.tee_key_exchange_nonce, "base64"), 32);
  const hkdfKey = await subtle.importKey("raw", sharedBits, "HKDF", false, [
    "deriveBits",
  ]);
  const sessionKeyBits = await subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: new TextEncoder().encode("brianni-tee-session-v1"),
    },
    hkdfKey,
    256,
  );
  const sessionKey = await subtle.importKey(
    "raw",
    sessionKeyBits,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  return { sessionKey };
}

async function drainFrames(
  router: any,
  frame: Buffer,
): Promise<{ type: number; payload: string }[]> {
  const out: { type: number; payload: string }[] = [];
  for await (const f of router.handleMessage(frame)) {
    const decoded = decodeFrame(f);
    out.push({ type: decoded.type, payload: decoded.payload.toString() });
  }
  return out;
}

async function makeRouter(opts: Record<string, unknown> = {}) {
  const { EnclaveRouter } = await import("../index");
  const router: any = new EnclaveRouter(opts as never);
  await router.init();
  return router;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("H1 — plaintext error frames carry allowlisted codes only", () => {
  it("DREAM_REQUEST: sentinel error never reaches the DREAM_ERROR frame", async () => {
    const router = await makeRouter();
    router.sessionManager.getSessionKey = vi
      .fn()
      .mockRejectedValue(new Error(`decrypt blew up: ${SENTINEL}`));
    const frames = await drainFrames(
      router,
      encodeFrame(
        MSG.DREAM_REQUEST,
        Buffer.from(JSON.stringify({ session_id: "s", ciphertext: "AAAA" })),
      ),
    );
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe(MSG.DREAM_ERROR);
    const payload = JSON.parse(frames[0].payload);
    expect(payload.error_code).toBe("DREAM_REQUEST_FAILED");
    expect(payload.message).toBe(payload.error_code);
    expect(frames[0].payload).not.toContain(SENTINEL);
  });

  it("DREAM_REQUEST: decrypted non-JSON body maps to a typed code with no source snippet", async () => {
    const router = await makeRouter();
    const sessionId = "redaction-dream-json";
    const { sessionKey } = await setupSession(router, sessionId);
    const ciphertext = await encryptChunk(
      sessionKey,
      Buffer.from(`{${SENTINEL}-not-json`),
    );
    const frames = await drainFrames(
      router,
      encodeFrame(
        MSG.DREAM_REQUEST,
        Buffer.from(
          JSON.stringify({
            session_id: sessionId,
            ciphertext: ciphertext.toString("base64"),
          }),
        ),
      ),
    );
    expect(frames[0].type).toBe(MSG.DREAM_ERROR);
    const payload = JSON.parse(frames[0].payload);
    expect(payload.error_code).toBe("DREAM_REQUEST_INVALID_PAYLOAD");
    expect(frames[0].payload).not.toContain(SENTINEL);
  });

  it("DREAM_REQUEST: dream LLM emitting prose maps to a code-only frame (no model text)", async () => {
    const proseTransport = {
      complete: vi.fn().mockResolvedValue({
        text: `Sorry, I cannot produce JSON. ${SENTINEL}`,
        inputTokens: 1,
        outputTokens: 1,
      }),
    };
    const router = await makeRouter({ dreamLlmTransport: proseTransport });
    const sessionId = "redaction-dream-prose";
    const { sessionKey } = await setupSession(router, sessionId);
    const candidate = {
      dreamSessionId: "dream-prose",
      userId: "user-1",
      namespace: "default",
      triggerKind: "nightly-consolidation",
      conversationMessages: [],
      existingMemoryRecords: [],
      preExtractedCandidates: [],
    };
    const ciphertext = await encryptChunk(
      sessionKey,
      Buffer.from(JSON.stringify(candidate)),
    );
    const frames = await drainFrames(
      router,
      encodeFrame(
        MSG.DREAM_REQUEST,
        Buffer.from(
          JSON.stringify({
            session_id: sessionId,
            ciphertext: ciphertext.toString("base64"),
          }),
        ),
      ),
    );
    expect(frames[0].type).toBe(MSG.DREAM_ERROR);
    const payload = JSON.parse(frames[0].payload);
    expect(payload.error_code).toBe("DREAM_REQUEST_FAILED");
    expect(frames[0].payload).not.toContain(SENTINEL);
  });

  it("DREAM_FINALISE: sentinel error never reaches the DREAM_ERROR frame", async () => {
    const router = await makeRouter();
    router.sessionManager.getSessionKey = vi
      .fn()
      .mockRejectedValue(new Error(`finalise blew up: ${SENTINEL}`));
    const frames = await drainFrames(
      router,
      encodeFrame(
        MSG.DREAM_FINALISE,
        Buffer.from(JSON.stringify({ session_id: "s", ciphertext: "AAAA" })),
      ),
    );
    expect(frames[0].type).toBe(MSG.DREAM_ERROR);
    const payload = JSON.parse(frames[0].payload);
    expect(payload.error_code).toBe("DREAM_FINALISE_FAILED");
    expect(frames[0].payload).not.toContain(SENTINEL);
  });

  it("DREAM_DONE: sentinel error never reaches the DREAM_ERROR frame", async () => {
    const router = await makeRouter();
    router.sessionManager.clearDreamSession = vi
      .fn()
      .mockRejectedValue(new Error(`clear blew up: ${SENTINEL}`));
    const frames = await drainFrames(
      router,
      encodeFrame(
        MSG.DREAM_DONE,
        Buffer.from(
          JSON.stringify({ session_id: "s", dreamSessionId: "d1" }),
        ),
      ),
    );
    expect(frames[0].type).toBe(MSG.DREAM_ERROR);
    const payload = JSON.parse(frames[0].payload);
    expect(payload.error_code).toBe("DREAM_DONE_FAILED");
    expect(frames[0].payload).not.toContain(SENTINEL);
  });

  it("AGENT_REQUEST: sentinel error never reaches the CHAT_ERROR frame", async () => {
    const router = await makeRouter();
    router.sessionManager.getSessionKey = vi
      .fn()
      .mockRejectedValue(new Error(`agent blew up: ${SENTINEL}`));
    const frames = await drainFrames(
      router,
      encodeFrame(
        MSG.AGENT_REQUEST,
        Buffer.from(
          JSON.stringify({
            session_id: "s",
            agent_turn_id: "turn-1",
            ciphertext: "AAAA",
          }),
        ),
      ),
    );
    expect(frames[0].type).toBe(MSG.CHAT_ERROR);
    const payload = JSON.parse(frames[0].payload);
    expect(payload.error_code).toBe("AGENT_REQUEST_FAILED");
    expect(payload.message).toBe(payload.error_code);
    expect(frames[0].payload).not.toContain(SENTINEL);
  });

  it("AGENT_REQUEST: known in-enclave codes still pass through as error_code", async () => {
    const router = await makeRouter();
    const sessionId = "redaction-agent-invalid";
    const { sessionKey } = await setupSession(router, sessionId);
    const ciphertext = await encryptChunk(
      sessionKey,
      Buffer.from(JSON.stringify({ messages: "nope", model: "auto" })),
    );
    const frames = await drainFrames(
      router,
      encodeFrame(
        MSG.AGENT_REQUEST,
        Buffer.from(
          JSON.stringify({
            session_id: sessionId,
            agent_turn_id: "turn-1",
            ciphertext: ciphertext.toString("base64"),
          }),
        ),
      ),
    );
    const last = frames[frames.length - 1];
    expect(last.type).toBe(MSG.CHAT_ERROR);
    const payload = JSON.parse(last.payload);
    expect(payload.error_code).toBe("AGENT_REQUEST_INVALID_MESSAGES");
    expect(payload.message).toBe(payload.error_code);
  });

  it("AGENT_REQUEST: rejected client role value never reaches the frame", async () => {
    const router = await makeRouter();
    const sessionId = "redaction-agent-role";
    const { sessionKey } = await setupSession(router, sessionId);
    const ciphertext = await encryptChunk(
      sessionKey,
      Buffer.from(
        JSON.stringify({
          messages: [{ role: SENTINEL, content: "hello" }],
          model: "auto",
        }),
      ),
    );
    const frames = await drainFrames(
      router,
      encodeFrame(
        MSG.AGENT_REQUEST,
        Buffer.from(
          JSON.stringify({
            session_id: sessionId,
            agent_turn_id: "turn-1",
            ciphertext: ciphertext.toString("base64"),
          }),
        ),
      ),
    );
    const last = frames[frames.length - 1];
    expect(last.type).toBe(MSG.CHAT_ERROR);
    const payload = JSON.parse(last.payload);
    expect(payload.error_code).toBe("AGENT_CLIENT_SYSTEM_ROLE_REJECTED");
    expect(last.payload.toLowerCase()).not.toContain(SENTINEL.toLowerCase());
  });

  it("TOOL_RESULT: sentinel error never reaches the CHAT_ERROR frame", async () => {
    const router = await makeRouter();
    router.sessionManager.getSessionKey = vi
      .fn()
      .mockRejectedValue(new Error(`tool result blew up: ${SENTINEL}`));
    const frames = await drainFrames(
      router,
      encodeFrame(
        MSG.TOOL_RESULT,
        Buffer.from(
          JSON.stringify({
            session_id: "s",
            agent_turn_id: "turn-1",
            ciphertext: "AAAA",
          }),
        ),
      ),
    );
    expect(frames[0].type).toBe(MSG.CHAT_ERROR);
    const payload = JSON.parse(frames[0].payload);
    expect(payload.error_code).toBe("TOOL_RESULT_FAILED");
    expect(frames[0].payload).not.toContain(SENTINEL);
  });

  it("RESEARCH_QUERY_APPROVAL_RESULT: sentinel error never reaches the CHAT_ERROR frame", async () => {
    const router = await makeRouter();
    router.sessionManager.getSessionKey = vi
      .fn()
      .mockRejectedValue(new Error(`approval blew up: ${SENTINEL}`));
    const frames = await drainFrames(
      router,
      encodeFrame(
        MSG.RESEARCH_QUERY_APPROVAL_RESULT,
        Buffer.from(JSON.stringify({ session_id: "s", ciphertext: "AAAA" })),
      ),
    );
    expect(frames[0].type).toBe(MSG.CHAT_ERROR);
    const payload = JSON.parse(frames[0].payload);
    expect(payload.error_code).toBe("RESEARCH_QUERY_APPROVAL_RESULT_FAILED");
    expect(frames[0].payload).not.toContain(SENTINEL);
  });

  it("AGENT_REQUEST: a sentinel that LOOKS like a code is not echoed (allowlist, not shape)", async () => {
    const router = await makeRouter();
    router.sessionManager.getSessionKey = vi
      .fn()
      .mockRejectedValue(new Error(`${SENTINEL.toUpperCase()}: payload-derived`));
    const frames = await drainFrames(
      router,
      encodeFrame(
        MSG.AGENT_REQUEST,
        Buffer.from(
          JSON.stringify({
            session_id: "s",
            agent_turn_id: "turn-1",
            ciphertext: "AAAA",
          }),
        ),
      ),
    );
    const payload = JSON.parse(frames[0].payload);
    expect(payload.error_code).toBe("AGENT_REQUEST_FAILED");
    expect(frames[0].payload.toUpperCase()).not.toContain(
      SENTINEL.toUpperCase(),
    );
  });
});

describe("M2 — CHAT decrypt/session failures map to honest codes", () => {
  it("corrupted ciphertext yields DECRYPT_FAILED (not PROVIDER_UNAVAILABLE)", async () => {
    const router = await makeRouter();
    const sessionId = "redaction-chat-decrypt";
    const { sessionKey } = await setupSession(router, sessionId);
    const good = await encryptChunk(
      sessionKey,
      Buffer.from(JSON.stringify({ model: "gpt-4o", messages: [] })),
    );
    good[good.length - 1] ^= 0xff; // corrupt the GCM tag
    const frames = await drainFrames(
      router,
      encodeFrame(
        MSG.CHAT_REQUEST,
        Buffer.from(
          JSON.stringify({
            session_id: sessionId,
            ciphertext: good.toString("base64"),
          }),
        ),
      ),
    );
    const last = frames[frames.length - 1];
    expect(last.type).toBe(MSG.CHAT_ERROR);
    expect(JSON.parse(last.payload).error_code).toBe("DECRYPT_FAILED");
  });

  it("unknown session yields SESSION_EXPIRED (not PROVIDER_UNAVAILABLE)", async () => {
    const router = await makeRouter();
    const frames = await drainFrames(
      router,
      encodeFrame(
        MSG.CHAT_REQUEST,
        Buffer.from(
          JSON.stringify({ session_id: "never-existed", ciphertext: "AAAA" }),
        ),
      ),
    );
    const last = frames[frames.length - 1];
    expect(last.type).toBe(MSG.CHAT_ERROR);
    expect(JSON.parse(last.payload).error_code).toBe("SESSION_EXPIRED");
  });
});

describe("H2 — mid-stream provider failure ends in CHAT_ERROR, never CHAT_DONE", () => {
  it("provider throw after partial output yields CHAT_ERROR with an opaque code", async () => {
    const registry = await import("../providers/registry");
    vi.mocked(registry.createProcessor).mockReturnValueOnce({
      streamChat: async function* () {
        yield {
          id: "t",
          choices: [{ delta: { content: "partial" }, finish_reason: null }],
        };
        throw new Error(`mid-stream provider error ${SENTINEL}`);
      },
    } as never);

    const router = await makeRouter();
    const sessionId = "redaction-chat-midstream";
    const { sessionKey } = await setupSession(router, sessionId);
    const ciphertext = await encryptChunk(
      sessionKey,
      Buffer.from(
        JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "hi" }],
        }),
      ),
    );
    const frames = await drainFrames(
      router,
      encodeFrame(
        MSG.CHAT_REQUEST,
        Buffer.from(
          JSON.stringify({
            session_id: sessionId,
            ciphertext: ciphertext.toString("base64"),
          }),
        ),
      ),
    );
    expect(frames.some((f) => f.type === MSG.CHAT_DONE)).toBe(false);
    const last = frames[frames.length - 1];
    expect(last.type).toBe(MSG.CHAT_ERROR);
    expect(JSON.parse(last.payload).error_code).toBe("PROVIDER_UNAVAILABLE");
    expect(last.payload).not.toContain(SENTINEL);
  });
});

describe("M3 — ATTESTATION_REQUEST / KEY_EXCHANGE emit typed frames and survive", () => {
  it("malformed ATTESTATION_REQUEST JSON yields ATTESTATION_FAILED, router keeps serving", async () => {
    const router = await makeRouter();
    const frames = await drainFrames(
      router,
      encodeFrame(
        MSG.ATTESTATION_REQUEST,
        Buffer.from(`{broken ${SENTINEL}`),
      ),
    );
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe(MSG.CHAT_ERROR);
    const payload = JSON.parse(frames[0].payload);
    expect(payload.error_code).toBe("ATTESTATION_FAILED");
    expect(payload.message).toBe("ATTESTATION_FAILED");
    expect(frames[0].payload).not.toContain(SENTINEL);

    // The connection-level listener survives: a follow-up HEALTH_PING works.
    const pong = await drainFrames(
      router,
      encodeFrame(MSG.HEALTH_PING, Buffer.alloc(0)),
    );
    expect(pong[0].type).toBe(MSG.HEALTH_PONG);
  });

  it("malformed KEY_EXCHANGE JSON yields KEY_EXCHANGE_FAILED, router keeps serving", async () => {
    const router = await makeRouter();
    const frames = await drainFrames(
      router,
      encodeFrame(MSG.KEY_EXCHANGE, Buffer.from(`{broken ${SENTINEL}`)),
    );
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe(MSG.CHAT_ERROR);
    const payload = JSON.parse(frames[0].payload);
    expect(payload.error_code).toBe("KEY_EXCHANGE_FAILED");
    expect(frames[0].payload).not.toContain(SENTINEL);

    const pong = await drainFrames(
      router,
      encodeFrame(MSG.HEALTH_PING, Buffer.alloc(0)),
    );
    expect(pong[0].type).toBe(MSG.HEALTH_PONG);
  });

  it("KEY_EXCHANGE with an unknown tee_public_key (expired keypair) yields a typed frame", async () => {
    const router = await makeRouter();
    const frames = await drainFrames(
      router,
      encodeFrame(
        MSG.KEY_EXCHANGE,
        Buffer.from(
          JSON.stringify({
            client_ephemeral_public_key: Buffer.alloc(65).toString("base64"),
            session_id: "kx-expired",
            client_key_exchange_nonce: Buffer.alloc(32).toString("base64"),
            tee_public_key: "no-such-keypair",
          }),
        ),
      ),
    );
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe(MSG.CHAT_ERROR);
    expect(JSON.parse(frames[0].payload).error_code).toBe(
      "KEY_EXCHANGE_FAILED",
    );
  });
});
