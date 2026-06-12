import { describe, it, expect, vi, beforeEach } from "vitest";
import { encodeFrame, decodeFrame, MSG } from "../vsock";
import { webcrypto } from "node:crypto";

const subtle = webcrypto.subtle;

// ---------------------------------------------------------------------------
// Regression guards for the chat attachment gates:
//
// 1. A modified client must NOT be able to smuggle `attachments` inside
//    messages[] — all three provider adapters read message.attachments, but
//    every validation gate (count/size/MIME/base64 shape + vision capability)
//    runs only on the TOP-LEVEL chatPayload.attachments. The enclave itself is
//    the only legitimate writer of message-level attachments (it copies the
//    validated top-level field onto the final user message), so any client-
//    supplied message-level attachments key is hard-rejected.
//
// 2. The vision-capability gate (CHAT_ATTACHMENTS_UNSUPPORTED) is a
//    deterministic client error and must surface as the non-retryable
//    INVALID_PAYLOAD, not fall through the classifier to the retryable
//    PROVIDER_UNAVAILABLE bucket.
// ---------------------------------------------------------------------------

// Mock provider registry — createProcessor(provider, apiKey) returns a ChatProcessor
vi.mock("../providers/registry", () => ({
  loadAndVerifyRegistry: vi.fn(),
  initRegistry: vi.fn(),
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
  getProviderForCustomModel: vi.fn(),
  createProcessor: vi.fn().mockReturnValue({
    streamChat: async function* () {
      yield {
        id: "test",
        choices: [{ delta: { content: "Hello" }, finish_reason: null }],
      };
      yield { id: "test", choices: [{ delta: {}, finish_reason: "stop" }] };
      return { provider: "openai", model: "gpt-4o" };
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

// A structurally valid attachment whose base64 really encodes `byteLength`
// bytes — passes validateChatImageAttachments, so the only gates left are the
// placement (message-level vs top-level) and vision-capability checks.
function makeAttachment(byteLength: number) {
  return {
    id: "att-1",
    kind: "image",
    mimeType: "image/png",
    sizeBytes: byteLength,
    dataBase64: Buffer.alloc(byteLength, 7).toString("base64"),
  };
}

// Full attest -> key-exchange handshake so the router holds a live session
// key (same derivation as chat-flow.test.ts).
async function setupSession(
  router: any,
  sessionId: string,
): Promise<webcrypto.CryptoKey> {
  const nonce = webcrypto.getRandomValues(new Uint8Array(32));
  let attestResp: Buffer | undefined;
  for await (const frame of router.handleMessage(
    encodeFrame(
      MSG.ATTESTATION_REQUEST,
      Buffer.from(
        JSON.stringify({ nonce: Buffer.from(nonce).toString("base64") }),
      ),
    ),
  )) {
    attestResp = frame;
  }
  const attestPayload = JSON.parse(decodeFrame(attestResp!).payload.toString());

  const clientKP = await subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const clientPubRaw = Buffer.from(
    await subtle.exportKey("raw", clientKP.publicKey),
  ).toString("base64");
  const clientNonce = Buffer.from(
    webcrypto.getRandomValues(new Uint8Array(32)),
  ).toString("base64");

  let kxResp: Buffer | undefined;
  for await (const frame of router.handleMessage(
    encodeFrame(
      MSG.KEY_EXCHANGE,
      Buffer.from(
        JSON.stringify({
          client_ephemeral_public_key: clientPubRaw,
          session_id: sessionId,
          client_key_exchange_nonce: clientNonce,
          tee_public_key: attestPayload.ephemeral_public_key,
        }),
      ),
    ),
  )) {
    kxResp = frame;
  }
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
  salt.set(Buffer.from(clientNonce, "base64"), 0);
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
  return subtle.importKey(
    "raw",
    sessionKeyBits,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// Encrypts `chatPayload` under the session key, sends the CHAT_REQUEST and
// returns every response frame decoded to { type, payload }.
async function sendChat(
  router: any,
  sessionId: string,
  sessionKey: webcrypto.CryptoKey,
  chatPayload: Record<string, unknown>,
): Promise<Array<{ type: number; payload: Buffer }>> {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const encryptedPayload = Buffer.from(
    await subtle.encrypt(
      { name: "AES-GCM", iv },
      sessionKey,
      Buffer.from(JSON.stringify(chatPayload)),
    ),
  );
  const ciphertext = Buffer.concat([Buffer.from(iv), encryptedPayload]);

  const frames: Array<{ type: number; payload: Buffer }> = [];
  for await (const frame of router.handleMessage(
    encodeFrame(
      MSG.CHAT_REQUEST,
      Buffer.from(
        JSON.stringify({
          session_id: sessionId,
          ciphertext: ciphertext.toString("base64"),
        }),
      ),
    ),
  )) {
    frames.push(decodeFrame(frame));
  }
  return frames;
}

describe("chat attachment gates", () => {
  let router: any;

  beforeEach(async () => {
    // Dynamic import so mocks are applied first
    const mod = await import("../index");
    router = new mod.EnclaveRouter();
    await router.init();
    // Deterministic key presence — rejection paths fire before the key
    // lookup, but the vision-capable happy path must reach the adapter.
    (router as any).providerKeys = { openai: "sk-test" };
  });

  it("hard-rejects client-supplied message-level attachments as INVALID_PAYLOAD", async () => {
    const registry = await import("../providers/registry");
    const getProviderForModelMock = registry.getProviderForModel as ReturnType<
      typeof vi.fn
    >;
    getProviderForModelMock.mockClear();

    const sessionKey = await setupSession(router, "msg-attach-session");
    const frames = await sendChat(router, "msg-attach-session", sessionKey, {
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: "What's in this image?",
          // Smuggled past the top-level validator — must be rejected, never
          // forwarded to the adapters.
          attachments: [makeAttachment(1200)],
        },
      ],
      stream: true,
    });

    const last = frames[frames.length - 1];
    expect(last.type).toBe(MSG.CHAT_ERROR);
    const errorPayload = JSON.parse(last.payload.toString());
    expect(errorPayload.error_code).toBe("INVALID_PAYLOAD");
    // The rejection fires during message validation, before provider
    // resolution — the payload never reaches the routing layer.
    expect(getProviderForModelMock).not.toHaveBeenCalled();
  });

  it("rejects even an empty message-level attachments key (presence, not content)", async () => {
    const sessionKey = await setupSession(router, "msg-attach-empty-session");
    const frames = await sendChat(
      router,
      "msg-attach-empty-session",
      sessionKey,
      {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi", attachments: [] }],
        stream: true,
      },
    );

    const last = frames[frames.length - 1];
    expect(last.type).toBe(MSG.CHAT_ERROR);
    expect(JSON.parse(last.payload.toString()).error_code).toBe(
      "INVALID_PAYLOAD",
    );
  });

  it("maps the vision-capability gate to INVALID_PAYLOAD, not PROVIDER_UNAVAILABLE", async () => {
    // Default mocked model has NO capabilities -> vision unsupported. A valid
    // top-level attachment therefore trips CHAT_ATTACHMENTS_UNSUPPORTED,
    // which must classify as the non-retryable INVALID_PAYLOAD.
    const sessionKey = await setupSession(router, "vision-gate-session");
    const frames = await sendChat(router, "vision-gate-session", sessionKey, {
      model: "gpt-4o",
      messages: [{ role: "user", content: "What's in this image?" }],
      attachments: [makeAttachment(1200)],
      stream: true,
    });

    const last = frames[frames.length - 1];
    expect(last.type).toBe(MSG.CHAT_ERROR);
    const errorPayload = JSON.parse(last.payload.toString());
    expect(errorPayload.error_code).toBe("INVALID_PAYLOAD");
    expect(errorPayload.error_code).not.toBe("PROVIDER_UNAVAILABLE");
  });

  it("still forwards validated top-level attachments onto the final user message for vision-capable models", async () => {
    const registry = await import("../providers/registry");
    (registry.getProviderForModel as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({
        provider: {
          id: "openai",
          adapter: "openai_v1",
          baseUrl: "https://api.openai.com/v1",
          apiKeyEnvVar: "OPENAI_API_KEY",
          models: [{ id: "gpt-4o", displayName: "GPT-4o" }],
        },
        model: {
          id: "gpt-4o",
          displayName: "GPT-4o",
          capabilities: {
            modalities: ["text_in", "image_in", "text_out"],
            endpointFamily: "chat",
            routingStatus: "enabled",
          },
        },
      });
    let captured: Array<Record<string, unknown>> | null = null;
    (registry.createProcessor as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({
        streamChat: async function* (messages: Array<Record<string, unknown>>) {
          captured = messages;
          yield {
            id: "t",
            choices: [{ delta: { content: "A cat." }, finish_reason: null }],
          };
          yield { id: "t", choices: [{ delta: {}, finish_reason: "stop" }] };
          return { provider: "openai", model: "gpt-4o" };
        },
      });

    const attachment = makeAttachment(1200);
    const sessionKey = await setupSession(router, "vision-ok-session");
    const frames = await sendChat(router, "vision-ok-session", sessionKey, {
      model: "gpt-4o",
      messages: [{ role: "user", content: "What's in this image?" }],
      attachments: [attachment],
      stream: true,
    });

    // Turn completes normally…
    expect(frames.some((f) => f.type === MSG.CHAT_ERROR)).toBe(false);
    expect(frames[frames.length - 1].type).toBe(MSG.CHAT_DONE);
    // …and the enclave (the only legitimate writer) attached the validated
    // top-level attachment to the final user message it sent the adapter.
    expect(captured).not.toBeNull();
    const lastMessage = captured![captured!.length - 1] as {
      role: string;
      attachments?: Array<{ id: string }>;
    };
    expect(lastMessage.role).toBe("user");
    expect(lastMessage.attachments).toHaveLength(1);
    expect(lastMessage.attachments![0].id).toBe(attachment.id);
  });
});
