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

// ---------------------------------------------------------------------------
// B10 — Attachment edge cases (docs/launch/agent-capability-verification.md §3)
//
// Gates under test (single source of truth):
//   - base64 shape regex .............. packages/chat-types/src/index.ts:89
//   - declared-size ±2-byte tolerance .. packages/chat-types/src/index.ts:101-113
//   - per-turn count cap (1 image) ..... packages/chat-types/src/index.ts:61
//   - latest-user-message binding ...... enclave/src/index.ts:1077-1085
//   - message-level replay rejection ... enclave/src/index.ts:1058-1062
//   - vision-capability gate ........... enclave/src/index.ts:1103-1110
//   - error classifier ................. enclave/src/index.ts:1375-1393
//
// Protocol note for the "chunked frames" scenarios: the vsock protocol has NO
// chunked CHAT_REQUEST — a chat turn (attachment included) is a single frame,
// and MAX_VSOCK_PAYLOAD (512 KiB) comfortably covers the worst-case 160 KiB
// image envelope. Chunking exists upstream (client → server HTTP transport and
// the agent-path TOOL_RESULT reassembler, which never carries chat
// attachments). So "malformed base64 inside chunked frames" is modelled at
// this seam as the three corruption shapes a chunked client/relay reassembly
// can produce in dataBase64 — a corrupt middle chunk, an independently padded
// middle chunk (interior '='), and a dropped middle chunk (truncation) — each
// of which must be rejected before ANY provider code runs, so no partial
// decode can ever reach an adapter.
//
// Statelessness note for the replay scenarios: the enclave zeroes the session
// after every CHAT_REQUEST (enclave/src/index.ts:1405), so "turn N+1" is a
// fresh handshake. The replay tests deliberately re-key the SAME session id so
// that any hypothetical per-session/per-attachment-id validation cache would
// be exercised — re-validation must happen on every turn.
// ---------------------------------------------------------------------------

const VISION_CAPS = {
  modalities: ["text_in", "image_in", "text_out"],
  endpointFamily: "chat",
  routingStatus: "enabled",
} as const;

const TEXT_ONLY_CAPS = {
  modalities: ["text_in", "text_out"],
  endpointFamily: "chat",
  routingStatus: "enabled",
} as const;

// Registry entry for gpt-4o with explicit capabilities (the module-level
// default mock has none, which already means "no vision").
function providerEntry(caps: Record<string, unknown>) {
  return {
    provider: {
      id: "openai",
      adapter: "openai_v1",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnvVar: "OPENAI_API_KEY",
      models: [{ id: "gpt-4o", displayName: "GPT-4o" }],
    },
    model: { id: "gpt-4o", displayName: "GPT-4o", capabilities: caps },
  };
}

// Adapter that records the exact messages it was handed, then completes.
function makeCaptureProcessor() {
  const captured: Array<Array<Record<string, unknown>>> = [];
  return {
    captured,
    processor: {
      streamChat: async function* (messages: Array<Record<string, unknown>>) {
        captured.push(messages);
        yield {
          id: "t",
          choices: [{ delta: { content: "A cat." }, finish_reason: null }],
        };
        yield { id: "t", choices: [{ delta: {}, finish_reason: "stop" }] };
        return { provider: "openai", model: "gpt-4o" };
      },
    },
  };
}

// Adapter whose stream dies mid-flight with a retryable provider error — the
// trigger for a client-driven fallback re-send.
function makeMidStreamFailureProcessor() {
  return {
    streamChat: async function* () {
      yield {
        id: "t",
        choices: [{ delta: { content: "par" }, finish_reason: null }],
      };
      throw new Error("OpenAI API error: 503 upstream connect failure");
    },
  };
}

function expectInvalidPayloadRejection(
  frames: Array<{ type: number; payload: Buffer }>,
) {
  const last = frames[frames.length - 1];
  expect(last.type).toBe(MSG.CHAT_ERROR);
  expect(JSON.parse(last.payload.toString()).error_code).toBe(
    "INVALID_PAYLOAD",
  );
  // Rejection means rejection: no content chunk and no DONE ever left the
  // enclave for this turn.
  expect(
    frames.some((f) => f.type === MSG.CHAT_CHUNK || f.type === MSG.CHAT_DONE),
  ).toBe(false);
}

describe("chat attachment edge cases (B10)", () => {
  let router: any;
  let registry: typeof import("../providers/registry");
  let getProviderForModelMock: ReturnType<typeof vi.fn>;
  let createProcessorMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import("../index");
    router = new mod.EnclaveRouter();
    await router.init();
    (router as any).providerKeys = { openai: "sk-test" };

    registry = await import("../providers/registry");
    getProviderForModelMock = registry.getProviderForModel as ReturnType<
      typeof vi.fn
    >;
    createProcessorMock = registry.createProcessor as ReturnType<typeof vi.fn>;
    getProviderForModelMock.mockClear();
    createProcessorMock.mockClear();
  });

  // -------------------------------------------------------------------------
  // 1. Malformed base64 inside chunked frames
  // -------------------------------------------------------------------------
  describe("malformed base64 from chunked-frame reassembly", () => {
    it("rejects a corrupt (non-base64) middle chunk before any provider code runs", async () => {
      // 90 bytes -> 120 base64 chars, no padding. Split into three 40-char
      // "chunks" and corrupt the middle one, as a flaky chunked uploader or
      // buggy relay reassembly would.
      const clean = Buffer.alloc(90, 7).toString("base64");
      const corrupted =
        clean.slice(0, 40) + "!!!@@@%%%^^^&&&***((()))___---:::;;;,,..".slice(0, 40) + clean.slice(80);
      expect(corrupted).toHaveLength(clean.length);

      const sessionKey = await setupSession(router, "b10-corrupt-chunk");
      const frames = await sendChat(router, "b10-corrupt-chunk", sessionKey, {
        model: "gpt-4o",
        messages: [{ role: "user", content: "What's in this image?" }],
        attachments: [
          {
            id: "att-corrupt",
            kind: "image",
            mimeType: "image/png",
            sizeBytes: 90,
            dataBase64: corrupted,
          },
        ],
        stream: true,
      });

      expectInvalidPayloadRejection(frames);
      // Attachment validation fires BEFORE provider resolution — no partial
      // decode can reach an adapter because not even routing happened.
      expect(getProviderForModelMock).not.toHaveBeenCalled();
      expect(createProcessorMock).not.toHaveBeenCalled();
    });

    it("rejects independently padded chunks (interior '=' after concatenation)", async () => {
      // Each chunk is VALID base64 on its own — the middle one encodes 31
      // bytes so it carries its own '==' terminator. Concatenating the three
      // chunk strings (the naive reassembly bug) yields interior padding,
      // which the shape regex must reject even though every chunk would have
      // passed in isolation.
      const chunkA = Buffer.alloc(30, 7).toString("base64"); // 40 chars
      const chunkB = Buffer.alloc(31, 7).toString("base64"); // ends with '=='
      const chunkC = Buffer.alloc(30, 7).toString("base64"); // 40 chars
      expect(chunkB.endsWith("=")).toBe(true);
      const reassembled = chunkA + chunkB + chunkC;

      const sessionKey = await setupSession(router, "b10-interior-padding");
      const frames = await sendChat(
        router,
        "b10-interior-padding",
        sessionKey,
        {
          model: "gpt-4o",
          messages: [{ role: "user", content: "What's in this image?" }],
          attachments: [
            {
              id: "att-padded",
              kind: "image",
              mimeType: "image/png",
              sizeBytes: 91,
              dataBase64: reassembled,
            },
          ],
          stream: true,
        },
      );

      expectInvalidPayloadRejection(frames);
      expect(getProviderForModelMock).not.toHaveBeenCalled();
      expect(createProcessorMock).not.toHaveBeenCalled();
    });

    it("rejects a dropped middle chunk (truncated but charset-valid base64) via the size gate", async () => {
      // Losing a middle chunk leaves charset-valid base64 the shape regex
      // cannot catch — the declared-size cross-check is the gate that must
      // bite (90 declared vs 60 decodable, far beyond the ±2 tolerance).
      const clean = Buffer.alloc(90, 7).toString("base64"); // 120 chars
      const truncated = clean.slice(0, 40) + clean.slice(80); // middle chunk lost

      const sessionKey = await setupSession(router, "b10-dropped-chunk");
      const frames = await sendChat(router, "b10-dropped-chunk", sessionKey, {
        model: "gpt-4o",
        messages: [{ role: "user", content: "What's in this image?" }],
        attachments: [
          {
            id: "att-truncated",
            kind: "image",
            mimeType: "image/png",
            sizeBytes: 90,
            dataBase64: truncated,
          },
        ],
        stream: true,
      });

      expectInvalidPayloadRejection(frames);
      expect(getProviderForModelMock).not.toHaveBeenCalled();
      expect(createProcessorMock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 2. Declared-size mismatch beyond the ±2-byte tolerance
  //    (packages/chat-types/src/index.ts:108 — `Math.abs(decoded - declared) > 2`)
  // -------------------------------------------------------------------------
  describe("declared-size mismatch beyond ±2 bytes", () => {
    it("rejects over-declaration by 3 bytes", async () => {
      const sessionKey = await setupSession(router, "b10-over-declared");
      const frames = await sendChat(router, "b10-over-declared", sessionKey, {
        model: "gpt-4o",
        messages: [{ role: "user", content: "What's in this image?" }],
        // Real data decodes to 1200 bytes; client claims 1203.
        attachments: [{ ...makeAttachment(1200), sizeBytes: 1203 }],
        stream: true,
      });

      expectInvalidPayloadRejection(frames);
      expect(getProviderForModelMock).not.toHaveBeenCalled();
      expect(createProcessorMock).not.toHaveBeenCalled();
    });

    it("rejects under-declaration by 3 bytes", async () => {
      const sessionKey = await setupSession(router, "b10-under-declared");
      const frames = await sendChat(router, "b10-under-declared", sessionKey, {
        model: "gpt-4o",
        messages: [{ role: "user", content: "What's in this image?" }],
        // Real data decodes to 1200 bytes; client claims 1197.
        attachments: [{ ...makeAttachment(1200), sizeBytes: 1197 }],
        stream: true,
      });

      expectInvalidPayloadRejection(frames);
      expect(getProviderForModelMock).not.toHaveBeenCalled();
      expect(createProcessorMock).not.toHaveBeenCalled();
    });

    it("boundary control: exactly ±2 bytes is tolerated (unpadded-encoder allowance)", async () => {
      // Proves the tolerance is exactly 2, not "about 2" — +3/-3 fail above,
      // +2/-2 must pass validation and complete against a vision model.
      for (const declared of [1202, 1198]) {
        getProviderForModelMock.mockReturnValueOnce(providerEntry(VISION_CAPS));
        const { captured, processor } = makeCaptureProcessor();
        createProcessorMock.mockReturnValueOnce(processor);

        const sessionId = `b10-tolerance-${declared}`;
        const sessionKey = await setupSession(router, sessionId);
        const frames = await sendChat(router, sessionId, sessionKey, {
          model: "gpt-4o",
          messages: [{ role: "user", content: "What's in this image?" }],
          attachments: [{ ...makeAttachment(1200), sizeBytes: declared }],
          stream: true,
        });

        expect(frames.some((f) => f.type === MSG.CHAT_ERROR)).toBe(false);
        expect(frames[frames.length - 1].type).toBe(MSG.CHAT_DONE);
        expect(captured).toHaveLength(1);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 3. Attachment to a non-vision-capable model mid-fallback
  //
  // The direct chat path has NO enclave-internal model fallback: one
  // resolveProviderForChatPayload, one streamChat, and any provider failure
  // surfaces as a retryable CHAT_ERROR for the CLIENT to act on (the
  // orchestrator's buildAttemptModelIds fallback never carries chat image
  // attachments). "Mid-fallback" therefore means: vision attempt fails, the
  // client re-sends the identical payload routed to a fallback model that is
  // NOT vision-capable. The enclave must re-run the vision gate on the
  // fallback request — typed rejection, never a silent image drop and never
  // base64 forwarded to a text-only adapter.
  // -------------------------------------------------------------------------
  describe("non-vision-capable model mid-fallback", () => {
    it("rejects the fallback re-send to a text-only model instead of silently dropping the image", async () => {
      const attachment = makeAttachment(1200);
      const chatPayload = {
        model: "gpt-4o",
        messages: [
          { role: "user", content: "What's in this image?" },
        ] as Array<Record<string, unknown>>,
        attachments: [attachment],
        stream: true,
      };

      // Attempt 1: vision-capable model, provider dies mid-stream — the
      // retryable failure that triggers client-side fallback.
      getProviderForModelMock.mockReturnValueOnce(providerEntry(VISION_CAPS));
      createProcessorMock.mockReturnValueOnce(makeMidStreamFailureProcessor());

      const key1 = await setupSession(router, "b10-fallback-attempt-1");
      const frames1 = await sendChat(
        router,
        "b10-fallback-attempt-1",
        key1,
        chatPayload,
      );
      const last1 = frames1[frames1.length - 1];
      expect(last1.type).toBe(MSG.CHAT_ERROR);
      expect(JSON.parse(last1.payload.toString()).error_code).toBe(
        "PROVIDER_UNAVAILABLE",
      );
      expect(createProcessorMock).toHaveBeenCalledTimes(1);

      // Attempt 2 (the fallback): identical payload, but routing now resolves
      // to a model WITHOUT image_in.
      getProviderForModelMock.mockReturnValueOnce(
        providerEntry(TEXT_ONLY_CAPS),
      );

      const key2 = await setupSession(router, "b10-fallback-attempt-2");
      const frames2 = await sendChat(
        router,
        "b10-fallback-attempt-2",
        key2,
        chatPayload,
      );

      // Typed, non-retryable rejection — NOT a silent strip (no CHAT_DONE)…
      expectInvalidPayloadRejection(frames2);
      // …and the text-only adapter never saw a byte of image base64: no
      // second createProcessor call ever happened.
      expect(createProcessorMock).toHaveBeenCalledTimes(1);
    });

    it("control: fallback to another vision-capable model carries the image intact", async () => {
      const attachment = makeAttachment(1200);
      const chatPayload = {
        model: "gpt-4o",
        messages: [
          { role: "user", content: "What's in this image?" },
        ] as Array<Record<string, unknown>>,
        attachments: [attachment],
        stream: true,
      };

      getProviderForModelMock.mockReturnValueOnce(providerEntry(VISION_CAPS));
      createProcessorMock.mockReturnValueOnce(makeMidStreamFailureProcessor());
      const key1 = await setupSession(router, "b10-fallback-ok-1");
      const frames1 = await sendChat(
        router,
        "b10-fallback-ok-1",
        key1,
        chatPayload,
      );
      expect(frames1[frames1.length - 1].type).toBe(MSG.CHAT_ERROR);

      // Fallback candidate IS vision-capable — the turn must complete with
      // the attachment still bound to the final user message.
      getProviderForModelMock.mockReturnValueOnce(providerEntry(VISION_CAPS));
      const { captured, processor } = makeCaptureProcessor();
      createProcessorMock.mockReturnValueOnce(processor);

      const key2 = await setupSession(router, "b10-fallback-ok-2");
      const frames2 = await sendChat(
        router,
        "b10-fallback-ok-2",
        key2,
        chatPayload,
      );

      expect(frames2.some((f) => f.type === MSG.CHAT_ERROR)).toBe(false);
      expect(frames2[frames2.length - 1].type).toBe(MSG.CHAT_DONE);
      const messages = captured[0];
      const lastMessage = messages[messages.length - 1] as {
        role: string;
        attachments?: Array<{ id: string }>;
      };
      expect(lastMessage.role).toBe("user");
      expect(lastMessage.attachments).toHaveLength(1);
      expect(lastMessage.attachments![0].id).toBe(attachment.id);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Attachment replay on a later turn
  // -------------------------------------------------------------------------
  describe("attachment replay on a later turn", () => {
    const SESSION_ID = "b10-replay-session";

    // Turn N: a legitimate attachment turn that completes. Returns the
    // attachment so turn-N+1 tests can replay it. The enclave zeroes the
    // session afterwards, so each later turn re-keys the SAME session id.
    async function runValidTurnN() {
      const attachment = makeAttachment(1200);
      getProviderForModelMock.mockReturnValueOnce(providerEntry(VISION_CAPS));
      const { processor } = makeCaptureProcessor();
      createProcessorMock.mockReturnValueOnce(processor);

      const sessionKey = await setupSession(router, SESSION_ID);
      const frames = await sendChat(router, SESSION_ID, sessionKey, {
        model: "gpt-4o",
        messages: [{ role: "user", content: "What's in this image?" }],
        attachments: [attachment],
        stream: true,
      });
      expect(frames[frames.length - 1].type).toBe(MSG.CHAT_DONE);
      return attachment;
    }

    it("re-validates on turn N+1 — a corrupted replay of a previously accepted attachment is rejected", async () => {
      const attachment = await runValidTurnN();
      createProcessorMock.mockClear();
      getProviderForModelMock.mockClear();

      // Same attachment id, same declared size — but the data is now
      // truncated. If turn-N validation were cached by id/session, this
      // would sail through; it must be rejected by the size gate instead.
      const corruptedReplay = {
        ...attachment,
        dataBase64: Buffer.alloc(600, 7).toString("base64"),
      };

      const sessionKey = await setupSession(router, SESSION_ID);
      const frames = await sendChat(router, SESSION_ID, sessionKey, {
        model: "gpt-4o",
        messages: [
          { role: "user", content: "What's in this image?" },
          { role: "assistant", content: "A cat." },
          { role: "user", content: "Look again at the same image." },
        ],
        attachments: [corruptedReplay],
        stream: true,
      });

      expectInvalidPayloadRejection(frames);
      expect(getProviderForModelMock).not.toHaveBeenCalled();
      expect(createProcessorMock).not.toHaveBeenCalled();
    });

    it("per-turn 1-image cap binds on turn N+1 even when one of the two is a replay", async () => {
      const attachment = await runValidTurnN();
      createProcessorMock.mockClear();
      getProviderForModelMock.mockClear();

      const newAttachment = { ...makeAttachment(800), id: "att-2" };

      const sessionKey = await setupSession(router, SESSION_ID);
      const frames = await sendChat(router, SESSION_ID, sessionKey, {
        model: "gpt-4o",
        messages: [
          { role: "user", content: "What's in this image?" },
          { role: "assistant", content: "A cat." },
          { role: "user", content: "Compare it with this new one." },
        ],
        // "Only one is new this turn" is not a loophole: the cap counts
        // attachments on the wire, replayed or not.
        attachments: [attachment, newAttachment],
        stream: true,
      });

      expectInvalidPayloadRejection(frames);
      expect(getProviderForModelMock).not.toHaveBeenCalled();
      expect(createProcessorMock).not.toHaveBeenCalled();
    });

    it("rejects a replay when the latest message is not a user turn (stale-turn replay)", async () => {
      const attachment = await runValidTurnN();
      createProcessorMock.mockClear();
      getProviderForModelMock.mockClear();

      const sessionKey = await setupSession(router, SESSION_ID);
      const frames = await sendChat(router, SESSION_ID, sessionKey, {
        model: "gpt-4o",
        // Client re-sends the old attachment without a new user message —
        // the attachment would bind to nothing this turn.
        messages: [
          { role: "user", content: "What's in this image?" },
          { role: "assistant", content: "A cat." },
        ],
        attachments: [attachment],
        stream: true,
      });

      expectInvalidPayloadRejection(frames);
      expect(getProviderForModelMock).not.toHaveBeenCalled();
      expect(createProcessorMock).not.toHaveBeenCalled();
    });

    it("rejects a replay smuggled message-level inside the turn-N history message", async () => {
      const attachment = await runValidTurnN();
      createProcessorMock.mockClear();
      getProviderForModelMock.mockClear();

      const sessionKey = await setupSession(router, SESSION_ID);
      const frames = await sendChat(router, SESSION_ID, sessionKey, {
        model: "gpt-4o",
        // The "natural" history-replay shape: the client replays the turn-N
        // user message WITH its attachments key. Message-level attachments
        // are enclave-only writes — hard reject, no strip.
        messages: [
          {
            role: "user",
            content: "What's in this image?",
            attachments: [attachment],
          },
          { role: "assistant", content: "A cat." },
          { role: "user", content: "And what colour was it?" },
        ],
        stream: true,
      });

      expectInvalidPayloadRejection(frames);
      expect(getProviderForModelMock).not.toHaveBeenCalled();
      expect(createProcessorMock).not.toHaveBeenCalled();
    });

    it("control: a clean top-level replay on turn N+1 is re-validated and bound ONLY to the new final user message", async () => {
      const attachment = await runValidTurnN();
      createProcessorMock.mockClear();
      getProviderForModelMock.mockClear();

      getProviderForModelMock.mockReturnValueOnce(providerEntry(VISION_CAPS));
      const { captured, processor } = makeCaptureProcessor();
      createProcessorMock.mockReturnValueOnce(processor);

      const sessionKey = await setupSession(router, SESSION_ID);
      const frames = await sendChat(router, SESSION_ID, sessionKey, {
        model: "gpt-4o",
        messages: [
          { role: "user", content: "What's in this image?" },
          { role: "assistant", content: "A cat." },
          { role: "user", content: "Zoom into the background." },
        ],
        attachments: [attachment],
        stream: true,
      });

      expect(frames.some((f) => f.type === MSG.CHAT_ERROR)).toBe(false);
      expect(frames[frames.length - 1].type).toBe(MSG.CHAT_DONE);

      const messages = captured[0];
      const lastMessage = messages[messages.length - 1] as {
        role: string;
        content: string;
        attachments?: Array<{ id: string }>;
      };
      expect(lastMessage.role).toBe("user");
      expect(lastMessage.attachments).toHaveLength(1);
      expect(lastMessage.attachments![0].id).toBe(attachment.id);
      // The enclave attaches to the FINAL user message only — the turn-N
      // history user message must NOT have grown an attachments key.
      const historyUser = messages.find(
        (m) => m.role === "user" && m.content === "What's in this image?",
      ) as { attachments?: unknown } | undefined;
      expect(historyUser).toBeDefined();
      expect(historyUser).not.toHaveProperty("attachments");
    });
  });
});
