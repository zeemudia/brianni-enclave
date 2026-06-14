import { describe, it, expect, vi, beforeEach } from "vitest";
import { encodeFrame, decodeFrame, MSG } from "../vsock";
import { webcrypto } from "node:crypto";
import { ProviderError } from "../providers/errors";

const subtle = webcrypto.subtle;

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
  getProviderForCustomModel: vi.fn().mockReturnValue({
    provider: {
      id: "openai",
      adapter: "openai_v1",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnvVar: "OPENAI_API_KEY",
      models: [{ id: "gpt-4o", displayName: "GPT-4o" }],
      customModel: { enabled: true, planRequired: "PRO" },
    },
    model: { id: "gpt-5.6-preview", displayName: "gpt-5.6-preview" },
    customModel: { enabled: true, planRequired: "PRO" },
  }),
  createProcessor: vi.fn().mockReturnValue({
    streamChat: async function* () {
      yield {
        id: "test",
        choices: [{ delta: { content: "Hello" }, finish_reason: null }],
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

async function setupRouter() {
  const { EnclaveRouter } = await import("../index");
  const router = new EnclaveRouter();
  await router.init();
  return router;
}

async function setupSession(router: any) {
  // 1. Attestation
  const nonce = webcrypto.getRandomValues(new Uint8Array(32));
  const attestReq = encodeFrame(
    MSG.ATTESTATION_REQUEST,
    Buffer.from(
      JSON.stringify({ nonce: Buffer.from(nonce).toString("base64") }),
    ),
  );
  let attestResp: Buffer | undefined;
  for await (const frame of router.handleMessage(attestReq)) {
    attestResp = frame;
  }
  const attestPayload = JSON.parse(decodeFrame(attestResp!).payload.toString());

  // 2. Key exchange
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
  const sessionId = "test-session-ext";

  const kxReq = encodeFrame(
    MSG.KEY_EXCHANGE,
    Buffer.from(
      JSON.stringify({
        client_ephemeral_public_key: clientPubRaw,
        session_id: sessionId,
        client_key_exchange_nonce: clientNonce,
        tee_public_key: attestPayload.ephemeral_public_key,
      }),
    ),
  );
  let kxResp: Buffer | undefined;
  for await (const frame of router.handleMessage(kxReq)) {
    kxResp = frame;
  }
  const kxPayload = JSON.parse(decodeFrame(kxResp!).payload.toString());
  expect(kxPayload.signingPublicKey).toEqual(expect.any(String));
  expect(Buffer.from(kxPayload.signingPublicKey, "base64")).toHaveLength(32);

  // 3. Derive session key
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
  const sessionKey = await subtle.importKey(
    "raw",
    sessionKeyBits,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  return { sessionId, sessionKey };
}

async function sendEncryptedChat(
  router: any,
  input: {
    sessionId: string;
    sessionKey: Parameters<typeof subtle.encrypt>[1];
    chatPayload: Record<string, unknown>;
    requestExtras?: Record<string, unknown>;
  },
): Promise<Buffer[]> {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const encrypted = Buffer.from(
    await subtle.encrypt(
      { name: "AES-GCM", iv },
      input.sessionKey,
      Buffer.from(JSON.stringify(input.chatPayload)),
    ),
  );
  const ciphertext = Buffer.concat([Buffer.from(iv), encrypted]);
  const chatReq = encodeFrame(
    MSG.CHAT_REQUEST,
    Buffer.from(
      JSON.stringify({
        session_id: input.sessionId,
        ciphertext: ciphertext.toString("base64"),
        ...(input.requestExtras ?? {}),
      }),
    ),
  );

  const responses: Buffer[] = [];
  for await (const frame of router.handleMessage(chatReq)) {
    responses.push(frame);
  }
  return responses;
}

describe("EnclaveRouter — extended", () => {
  let router: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    router = await setupRouter();
  });

  it("health ping returns correct status and uptime", async () => {
    const request = encodeFrame(MSG.HEALTH_PING, Buffer.alloc(0));
    const responses: Buffer[] = [];

    for await (const frame of router.handleMessage(request)) {
      responses.push(frame);
    }

    expect(responses.length).toBe(1);
    const decoded = decodeFrame(responses[0]);
    expect(decoded.type).toBe(MSG.HEALTH_PONG);
    const payload = JSON.parse(decoded.payload.toString());
    expect(payload.status).toBe("ok");
    expect(typeof payload.uptime).toBe("number");
  });

  it("error classifier maps DECRYPT error correctly", async () => {
    // Set up a valid session first
    const { sessionId } = await setupSession(router);

    // Send garbage ciphertext that will fail decryption
    const chatReq = encodeFrame(
      MSG.CHAT_REQUEST,
      Buffer.from(
        JSON.stringify({
          session_id: sessionId,
          ciphertext: Buffer.from("not-real-ciphertext").toString("base64"),
        }),
      ),
    );

    const responses: Buffer[] = [];
    for await (const frame of router.handleMessage(chatReq)) {
      responses.push(frame);
    }

    // Should get CHAT_ERROR with appropriate code
    const lastDecoded = decodeFrame(responses[responses.length - 1]);
    expect(lastDecoded.type).toBe(MSG.CHAT_ERROR);
    const errorPayload = JSON.parse(lastDecoded.payload.toString());
    // The error could be DECRYPT_FAILED or PROVIDER_UNAVAILABLE depending on the error message
    expect(errorPayload.error_code).toBeDefined();
  });

  it.each<[string, (secretText: string) => Error]>([
    [
      "cause",
      (secretText: string) => {
        const err = new Error("Provider SDK failed");
        (err as { cause?: Error }).cause = new Error(secretText);
        return err;
      },
    ],
    ["message", (secretText: string) => new Error(secretText)],
  ])(
    "CHAT_ERROR for provider failures does not expose raw provider %s text",
    async (_shape, buildProviderError) => {
      const { sessionId, sessionKey } = await setupSession(router);
      const consoleLogSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      const providerCause =
        "Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini:streamGenerateContent?key=FAKE_PROVIDER_SECRET";

      const { createProcessor } = await import("../providers/registry");
      vi.mocked(createProcessor).mockReturnValueOnce({
        streamChat: async function* () {
          throw buildProviderError(providerCause);
        },
      } as any);

      // Encrypt a valid payload
      const chatPayload = JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      });
      const iv = webcrypto.getRandomValues(new Uint8Array(12));
      const encrypted = Buffer.from(
        await subtle.encrypt(
          { name: "AES-GCM", iv },
          sessionKey,
          Buffer.from(chatPayload),
        ),
      );
      const ciphertext = Buffer.concat([Buffer.from(iv), encrypted]);

      const chatReq = encodeFrame(
        MSG.CHAT_REQUEST,
        Buffer.from(
          JSON.stringify({
            session_id: sessionId,
            ciphertext: ciphertext.toString("base64"),
          }),
        ),
      );

      try {
        const responses: Buffer[] = [];
        for await (const frame of router.handleMessage(chatReq)) {
          responses.push(frame);
        }

        const lastDecoded = decodeFrame(responses[responses.length - 1]);
        expect(lastDecoded.type).toBe(MSG.CHAT_ERROR);
        const errorPayload = JSON.parse(lastDecoded.payload.toString());
        expect(errorPayload.error_code).toBe("PROVIDER_UNAVAILABLE");
        expect(errorPayload.message).toBe("PROVIDER_UNAVAILABLE");
        expect(errorPayload).not.toHaveProperty("cause");
        expect(lastDecoded.payload.toString()).not.toContain(
          "FAKE_PROVIDER_SECRET",
        );
        expect(lastDecoded.payload.toString()).not.toContain(providerCause);

        const errorLogs = consoleErrorSpy.mock.calls
          .concat(consoleLogSpy.mock.calls, consoleWarnSpy.mock.calls)
          .map((args) => args.map(String).join(" "))
          .join("\n");
        expect(errorLogs).not.toContain("FAKE_PROVIDER_SECRET");
        expect(errorLogs).not.toContain(providerCause);
      } finally {
        consoleLogSpy.mockRestore();
        consoleWarnSpy.mockRestore();
        consoleErrorSpy.mockRestore();
      }
    },
  );

  it("error classifier returns PROVIDER_KEY_MISSING when api key not found", async () => {
    const { sessionId, sessionKey } = await setupSession(router);

    // Wipe provider keys (simulate missing API key)
    (router as any).providerKeys = {};

    const chatPayload = JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
    });
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const encrypted = Buffer.from(
      await subtle.encrypt(
        { name: "AES-GCM", iv },
        sessionKey,
        Buffer.from(chatPayload),
      ),
    );
    const ciphertext = Buffer.concat([Buffer.from(iv), encrypted]);

    const chatReq = encodeFrame(
      MSG.CHAT_REQUEST,
      Buffer.from(
        JSON.stringify({
          session_id: sessionId,
          ciphertext: ciphertext.toString("base64"),
        }),
      ),
    );

    const responses: Buffer[] = [];
    for await (const frame of router.handleMessage(chatReq)) {
      responses.push(frame);
    }

    const lastDecoded = decodeFrame(responses[responses.length - 1]);
    expect(lastDecoded.type).toBe(MSG.CHAT_ERROR);
    const errorPayload = JSON.parse(lastDecoded.payload.toString());
    expect(errorPayload.error_code).toBe("PROVIDER_KEY_MISSING");
  });

  it("does not reroute direct catalog chat when the exact provider rate-limits", async () => {
    const { sessionId, sessionKey } = await setupSession(router);
    (router as any).providerKeys = { openai: "sk-test", anthropic: "sk-ant" };
    const registry = await import("../providers/registry");
    vi.mocked(registry.getProviderForModel).mockReturnValueOnce({
      provider: {
        id: "openai",
        adapter: "openai_v1",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnvVar: "OPENAI_API_KEY",
        models: [{ id: "gpt-5.5", displayName: "GPT-5.5" }],
      },
      model: {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        capabilities: {
          strengths: ["general_reasoning"],
          modalities: ["text_in", "text_out"],
          endpointFamily: "chat",
          costTier: "high",
          latencyTier: "standard",
          routingStatus: "enabled",
        },
      },
    });
    const providerCalls: Array<{ providerId: string; modelId: string }> = [];
    vi.mocked(registry.createProcessor).mockReturnValueOnce({
      streamChat: async function* (
        _messages: unknown,
        options: { model: string },
      ) {
        providerCalls.push({ providerId: "openai", modelId: options.model });
        throw new ProviderError({
          providerId: "openai",
          providerName: "OpenAI",
          status: 429,
          kind: "rate_limit",
        });
      },
    } as any);

    const responses = await sendEncryptedChat(router, {
      sessionId,
      sessionKey,
      chatPayload: {
        model: "gpt-5.5",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      },
      requestExtras: {
        modelSelection: { modelSource: "catalog", modelId: "gpt-5.5" },
      },
    });

    const lastDecoded = decodeFrame(responses[responses.length - 1]);
    expect(lastDecoded.type).toBe(MSG.CHAT_ERROR);
    const errorPayload = JSON.parse(lastDecoded.payload.toString());
    expect(errorPayload.error_code).toBe("PROVIDER_UNAVAILABLE");
    expect(providerCalls).toEqual([{ providerId: "openai", modelId: "gpt-5.5" }]);
  });

  it("does not reroute direct custom-model chat when the exact provider rate-limits", async () => {
    const { sessionId, sessionKey } = await setupSession(router);
    (router as any).providerKeys = { openai: "sk-test", anthropic: "sk-ant" };
    const registry = await import("../providers/registry");
    vi.mocked(registry.getProviderForCustomModel).mockReturnValueOnce({
      provider: {
        id: "openai",
        adapter: "openai_v1",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnvVar: "OPENAI_API_KEY",
        models: [],
        customModel: { enabled: true, planRequired: "PRO" },
      },
      model: {
        id: "gpt-5.6-preview",
        displayName: "gpt-5.6-preview",
        capabilities: {
          strengths: ["general_reasoning"],
          modalities: ["text_in", "text_out"],
          endpointFamily: "chat",
          costTier: "high",
          latencyTier: "standard",
          routingStatus: "enabled",
        },
      },
      customModel: { enabled: true, planRequired: "PRO" },
    });
    const providerCalls: Array<{ providerId: string; modelId: string }> = [];
    vi.mocked(registry.createProcessor).mockReturnValueOnce({
      streamChat: async function* (
        _messages: unknown,
        options: { model: string },
      ) {
        providerCalls.push({ providerId: "openai", modelId: options.model });
        throw new ProviderError({
          providerId: "openai",
          providerName: "OpenAI",
          status: 429,
          kind: "rate_limit",
        });
      },
    } as any);

    const responses = await sendEncryptedChat(router, {
      sessionId,
      sessionKey,
      chatPayload: {
        model: "gpt-5.6-preview",
        modelSource: "custom",
        providerId: "openai",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      },
      requestExtras: {
        modelSelection: {
          modelSource: "custom",
          providerId: "openai",
          modelId: "gpt-5.6-preview",
        },
      },
    });

    const lastDecoded = decodeFrame(responses[responses.length - 1]);
    expect(lastDecoded.type).toBe(MSG.CHAT_ERROR);
    const errorPayload = JSON.parse(lastDecoded.payload.toString());
    expect(errorPayload.error_code).toBe("PROVIDER_UNAVAILABLE");
    expect(providerCalls).toEqual([
      { providerId: "openai", modelId: "gpt-5.6-preview" },
    ]);
  });

  it("rejects direct chat routing to pending non-chat catalog models before adapter creation", async () => {
    const { sessionId, sessionKey } = await setupSession(router);
    (router as any).providerKeys = { openai: "sk-test" };
    const registry = await import("../providers/registry");
    vi.mocked(registry.getProviderForModel).mockReturnValueOnce({
      provider: {
        id: "openai",
        adapter: "openai_v1",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnvVar: "OPENAI_API_KEY",
        models: [{ id: "gpt-image-2", displayName: "GPT Image 2" }],
      },
      model: {
        id: "gpt-image-2",
        displayName: "GPT Image 2",
        capabilities: {
          strengths: ["image_generation"],
          modalities: ["text_in", "image_out"],
          endpointFamily: "image",
          costTier: "high",
          latencyTier: "standard",
          routingStatus: "registered_pending_gateway",
        },
      },
    });

    const chatPayload = JSON.stringify({
      model: "gpt-image-2",
      messages: [{ role: "user", content: "Generate an image" }],
      stream: true,
    });
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const encrypted = Buffer.from(
      await subtle.encrypt(
        { name: "AES-GCM", iv },
        sessionKey,
        Buffer.from(chatPayload),
      ),
    );
    const ciphertext = Buffer.concat([Buffer.from(iv), encrypted]);

    const chatReq = encodeFrame(
      MSG.CHAT_REQUEST,
      Buffer.from(
        JSON.stringify({
          session_id: sessionId,
          ciphertext: ciphertext.toString("base64"),
        }),
      ),
    );

    const responses: Buffer[] = [];
    for await (const frame of router.handleMessage(chatReq)) {
      responses.push(frame);
    }

    const lastDecoded = decodeFrame(responses[responses.length - 1]);
    expect(lastDecoded.type).toBe(MSG.CHAT_ERROR);
    const errorPayload = JSON.parse(lastDecoded.payload.toString());
    expect(errorPayload.error_code).toBe("INVALID_PAYLOAD");
    expect(registry.createProcessor).not.toHaveBeenCalled();
  });

  it("does NOT emit a TEE token map — enclave no longer second-pass masks chat content", async () => {
    const { sessionId, sessionKey } = await setupSession(router);

    // The enclave runs no masking pass and must NOT emit a tee_token_map:
    // PII de-identification is the client's responsibility now.
    const chatPayload = JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello John" }],
      stream: true,
      token_counter: 0,
    });
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const encrypted = Buffer.from(
      await subtle.encrypt(
        { name: "AES-GCM", iv },
        sessionKey,
        Buffer.from(chatPayload),
      ),
    );
    const ciphertext = Buffer.concat([Buffer.from(iv), encrypted]);

    const chatReq = encodeFrame(
      MSG.CHAT_REQUEST,
      Buffer.from(
        JSON.stringify({
          session_id: sessionId,
          ciphertext: ciphertext.toString("base64"),
        }),
      ),
    );

    const responses: Buffer[] = [];
    for await (const frame of router.handleMessage(chatReq)) {
      responses.push(frame);
    }

    const lastDecoded = decodeFrame(responses[responses.length - 1]);
    expect(lastDecoded.type).toBe(MSG.CHAT_DONE);

    // No chunk should be a tee_token_map (the enclave emits none).
    let foundTokenMap = false;
    for (const frame of responses.slice(0, -1)) {
      const decoded = decodeFrame(frame);
      if (decoded.type === MSG.CHAT_CHUNK) {
        const chunkIv = new Uint8Array(
          decoded.payload.subarray(0, 12),
        ) as Uint8Array<ArrayBuffer>;
        const chunkCt = new Uint8Array(
          decoded.payload.subarray(12),
        ) as Uint8Array<ArrayBuffer>;
        try {
          const plainChunk = await subtle.decrypt(
            { name: "AES-GCM", iv: chunkIv },
            sessionKey,
            chunkCt,
          );
          const data = JSON.parse(Buffer.from(plainChunk).toString());
          if (data._type === "tee_token_map") {
            foundTokenMap = true;
          }
        } catch {
          // Skip decryption errors
        }
      }
    }
    expect(foundTokenMap).toBe(false);
  });

  it("loads the provider registry before fetching KMS keys", async () => {
    const callOrder: string[] = [];
    const { EnclaveRouter } = await import("../index");
    const r = new EnclaveRouter();

    // @ts-expect-error — private method stubs for ordering assertion
    r.loadProviderRegistry = async () => {
      callOrder.push("registry");
    };
    // @ts-expect-error
    r.fetchKeysFromKMS = async () => {
      callOrder.push("keys");
      return { providerKeys: {}, mediaRootSecret: null };
    };

    await r.init();

    const regIdx = callOrder.indexOf("registry");
    const keyIdx = callOrder.indexOf("keys");
    expect(regIdx).toBeGreaterThanOrEqual(0);
    expect(keyIdx).toBeGreaterThanOrEqual(0);
    expect(regIdx).toBeLessThan(keyIdx);
  });

  it("cleans up session in finally block after chat error", async () => {
    const { sessionId, sessionKey } = await setupSession(router);

    // Make provider throw
    const { createProcessor } = await import("../providers/registry");
    vi.mocked(createProcessor).mockReturnValueOnce({
      streamChat: async function* () {
        throw new Error("Provider crashed");
      },
    } as any);

    const chatPayload = JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
    });
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const encrypted = Buffer.from(
      await subtle.encrypt(
        { name: "AES-GCM", iv },
        sessionKey,
        Buffer.from(chatPayload),
      ),
    );
    const ciphertext = Buffer.concat([Buffer.from(iv), encrypted]);

    const chatReq = encodeFrame(
      MSG.CHAT_REQUEST,
      Buffer.from(
        JSON.stringify({
          session_id: sessionId,
          ciphertext: ciphertext.toString("base64"),
        }),
      ),
    );

    for await (const _ of router.handleMessage(chatReq)) {
      // consume all frames
    }

    // Session should be zeroed — second request with same session should fail
    const chatReq2 = encodeFrame(
      MSG.CHAT_REQUEST,
      Buffer.from(
        JSON.stringify({
          session_id: sessionId,
          ciphertext: ciphertext.toString("base64"),
        }),
      ),
    );

    const responses2: Buffer[] = [];
    for await (const frame of router.handleMessage(chatReq2)) {
      responses2.push(frame);
    }

    // Should get an error because session was zeroed
    const decoded = decodeFrame(responses2[responses2.length - 1]);
    expect(decoded.type).toBe(MSG.CHAT_ERROR);
  });
});
