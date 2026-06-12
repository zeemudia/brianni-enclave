import { describe, it, expect, vi, beforeEach } from "vitest";
import { encodeFrame, decodeFrame, MSG } from "../vsock";
import { webcrypto } from "node:crypto";
import { decodeUsageReport } from "@calypso/chat-types";

const subtle = webcrypto.subtle;

// Runs a full attest -> key-exchange -> chat turn and returns the assembled
// user-visible assistant text plus any regulated-topic signal the enclave
// emitted. Lets the model-tagged disclaimer be asserted end-to-end through the
// encrypted wire (token stripped from text, topics surfaced via the signal).
async function runChatTurn(
  router: any,
  userContent: string,
): Promise<{
  text: string;
  topics: string[];
  citations: Array<Record<string, unknown>>;
}> {
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
  const sessionId = "disclaimer-session";

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
  const sessionKey = await subtle.importKey(
    "raw",
    sessionKeyBits,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const encryptedPayload = Buffer.from(
    await subtle.encrypt(
      { name: "AES-GCM", iv },
      sessionKey,
      Buffer.from(
        JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: userContent }],
          stream: true,
          privacyLevel: "strict",
        }),
      ),
    ),
  );
  const ciphertext = Buffer.concat([Buffer.from(iv), encryptedPayload]);

  const responses: Buffer[] = [];
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
    responses.push(frame);
  }

  let text = "";
  let topics: string[] = [];
  const citations: Array<Record<string, unknown>> = [];
  for (const frame of responses) {
    const decoded = decodeFrame(frame);
    if (decoded.type !== MSG.CHAT_CHUNK) continue;
    const chunkIv = new Uint8Array(
      decoded.payload.subarray(0, 12),
    ) as Uint8Array<ArrayBuffer>;
    const chunkCt = new Uint8Array(
      decoded.payload.subarray(12),
    ) as Uint8Array<ArrayBuffer>;
    const plain = await subtle.decrypt(
      { name: "AES-GCM", iv: chunkIv },
      sessionKey,
      chunkCt,
    );
    const chunk = JSON.parse(Buffer.from(plain).toString());
    if (chunk?._type === "disclaimer") {
      topics = chunk.topics;
      continue;
    }
    if (Array.isArray(chunk?.citations)) citations.push(...chunk.citations);
    const content = chunk?.choices?.[0]?.delta?.content;
    if (typeof content === "string") text += content;
  }
  return { text, topics, citations };
}

// Override the mocked provider's streamChat for one turn so the "model" emits a
// specific token stream (e.g. the leading [[topics:...]] control line).
async function withProviderStream(
  chunks: Array<Record<string, unknown>>,
  fn: () => Promise<void>,
): Promise<void> {
  const registry = await import("../providers/registry");
  const prev = (registry.createProcessor as any).getMockImplementation();
  (registry.createProcessor as any).mockReturnValue({
    streamChat: async function* () {
      for (const c of chunks) yield c;
      return { provider: "openai", model: "gpt-4o" };
    },
  });
  try {
    await fn();
  } finally {
    if (prev) (registry.createProcessor as any).mockImplementation(prev);
  }
}

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
      return {
        provider: "openai",
        model: "gpt-4o",
        usage: { prompt_tokens: 12, completion_tokens: 7 },
      };
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

describe("EnclaveRouter", () => {
  let EnclaveRouter: any;
  let router: any;

  beforeEach(async () => {
    // Dynamic import so mocks are applied first
    const mod = await import("../index");
    EnclaveRouter = mod.EnclaveRouter;
    router = new EnclaveRouter();
    await router.init();
  });

  it("handles HEALTH_PING with HEALTH_PONG", async () => {
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
  });

  it("handles ATTESTATION_REQUEST -> ATTESTATION_RESPONSE", async () => {
    const nonce = webcrypto.getRandomValues(new Uint8Array(32));
    const request = encodeFrame(
      MSG.ATTESTATION_REQUEST,
      Buffer.from(
        JSON.stringify({ nonce: Buffer.from(nonce).toString("base64") }),
      ),
    );
    const responses: Buffer[] = [];

    for await (const frame of router.handleMessage(request)) {
      responses.push(frame);
    }

    expect(responses.length).toBe(1);
    const decoded = decodeFrame(responses[0]);
    expect(decoded.type).toBe(MSG.ATTESTATION_RESPONSE);
    const payload = JSON.parse(decoded.payload.toString());
    expect(payload.ephemeral_public_key).toBeDefined();
  });

  it("full flow: attest -> key exchange -> chat -> done", async () => {
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
    const attestPayload = JSON.parse(
      decodeFrame(attestResp!).payload.toString(),
    );

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
    const sessionId = "test-session";

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
    const kxDecoded = decodeFrame(kxResp!);
    expect(kxDecoded.type).toBe(MSG.KEY_EXCHANGE_ACK);
    const kxPayload = JSON.parse(kxDecoded.payload.toString());
    expect(kxPayload.status).toBe("ok");
    expect(kxPayload.tee_key_exchange_nonce).toBeDefined();

    // 3. Derive client-side session key (same HKDF as enclave)
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

    // 4. Encrypt chat payload
    const chatPayload = JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
      privacyLevel: "strict",
    });
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const encryptedPayload = Buffer.from(
      await subtle.encrypt(
        { name: "AES-GCM", iv },
        sessionKey,
        Buffer.from(chatPayload),
      ),
    );
    const ciphertext = Buffer.concat([Buffer.from(iv), encryptedPayload]);

    const chatReq = encodeFrame(
      MSG.CHAT_REQUEST,
      Buffer.from(
        JSON.stringify({
          session_id: sessionId,
          requestId: "req_usage_chat_flow",
          ciphertext: ciphertext.toString("base64"),
        }),
      ),
    );

    // 5. Collect response chunks
    const responses: Buffer[] = [];
    for await (const frame of router.handleMessage(chatReq)) {
      responses.push(frame);
    }

    // Should get CHAT_CHUNK(s) + CHAT_DONE
    expect(responses.length).toBeGreaterThanOrEqual(2);
    const lastDecoded = decodeFrame(responses[responses.length - 1]);
    expect(lastDecoded.type).toBe(MSG.CHAT_DONE);
    const usageDecoded = decodeFrame(responses[responses.length - 2]);
    expect(usageDecoded.type).toBe(MSG.USAGE_REPORT);
    expect(decodeUsageReport(usageDecoded.payload)).toEqual({
      requestId: "req_usage_chat_flow",
      routeKind: "chat",
      providerId: "openai",
      model: "gpt-4o",
      inputTokens: 12,
      cacheCreationInputTokens: 0,
      cachedInputTokens: 0,
      inputTokensIncludeCachedTokens: true,
      outputTokens: 7,
      providerUsagePresent: true,
    });
    // PII de-identification is performed ON-DEVICE by the client; the
    // enclave runs no masking pass at all (the Presidio sidecar was removed
    // entirely — it over-masked benign tokens such as filenames and
    // place/org names, degrading answers). The enclave forwards content
    // exactly as the client masked it.

    // Verify encrypted chunks are decryptable
    for (const frame of responses.slice(0, -1)) {
      const decoded = decodeFrame(frame);
      if (decoded.type === MSG.CHAT_CHUNK) {
        const encChunk = decoded.payload;
        const chunkIv = new Uint8Array(
          encChunk.subarray(0, 12),
        ) as Uint8Array<ArrayBuffer>;
        const chunkCt = new Uint8Array(
          encChunk.subarray(12),
        ) as Uint8Array<ArrayBuffer>;
        const plainChunk = await subtle.decrypt(
          { name: "AES-GCM", iv: chunkIv },
          sessionKey,
          chunkCt,
        );
        const chunkData = JSON.parse(Buffer.from(plainChunk).toString());
        expect(chunkData.choices).toBeDefined();
      }
    }
  });

  it("strips the model's [[topics:health]] control line and emits a disclaimer signal", async () => {
    await withProviderStream(
      [
        {
          id: "t",
          choices: [
            {
              delta: { content: "[[topics:health]]\nYes, use a moisturizer." },
              finish_reason: null,
            },
          ],
        },
        { id: "t", choices: [{ delta: {}, finish_reason: "stop" }] },
      ],
      async () => {
        const { text, topics } = await runChatTurn(
          router,
          "Do I still need face cream with salicylic acid?",
        );
        // Control token is stripped from the user-visible answer…
        expect(text).toBe("Yes, use a moisturizer.");
        expect(text).not.toContain("[[topics");
        // …and surfaced as a structured signal for the client banner.
        expect(topics).toEqual(["health"]);
      },
    );
  });

  it("handles the token split across stream chunks and yields no signal for `none`", async () => {
    await withProviderStream(
      [
        { id: "t", choices: [{ delta: { content: "[[topics:" }, finish_reason: null }] },
        { id: "t", choices: [{ delta: { content: "none]]\nHere's a " }, finish_reason: null }] },
        { id: "t", choices: [{ delta: { content: "haiku about autumn." }, finish_reason: null }] },
        { id: "t", choices: [{ delta: {}, finish_reason: "stop" }] },
      ],
      async () => {
        const { text, topics } = await runChatTurn(router, "Write me a haiku.");
        expect(text).toBe("Here's a haiku about autumn.");
        expect(topics).toEqual([]);
      },
    );
  });

  it("forwards the answer unchanged when the model omits the control token", async () => {
    // Default mocked provider answers plain "Hello" with no token.
    const { text, topics } = await runChatTurn(router, "Hi there");
    expect(text).toContain("Hello");
    expect(text).not.toContain("[[topics");
    expect(topics).toEqual([]);
  });

  it("never leaks the token when the model omits the trailing newline", async () => {
    // Regression for the review HIGH finding: a model that writes the token
    // inline without a newline must still have it stripped end-to-end.
    await withProviderStream(
      [
        {
          id: 't',
          choices: [
            {
              delta: { content: '[[topics:health]] Yes, use a moisturizer.' },
              finish_reason: null,
            },
          ],
        },
        { id: 't', choices: [{ delta: {}, finish_reason: 'stop' }] },
      ],
      async () => {
        const { text, topics } = await runChatTurn(router, 'skincare?');
        expect(text).toBe('Yes, use a moisturizer.');
        expect(text).not.toContain('[[topics');
        expect(topics).toEqual(['health']);
      },
    );
  });

  it("never leaks the token when a preamble and token arrive in separate chunks", async () => {
    // The realistic leak: a model that ignores "put it first" and streams a
    // preamble delta, THEN the token delta, THEN the answer. The bounded
    // leading-window buffer must still strip the token end-to-end.
    await withProviderStream(
      [
        { id: 't', choices: [{ delta: { content: 'Sure!\n' }, finish_reason: null }] },
        { id: 't', choices: [{ delta: { content: '[[topics:health]]\n' }, finish_reason: null }] },
        { id: 't', choices: [{ delta: { content: 'Use a moisturizer.' }, finish_reason: null }] },
        { id: 't', choices: [{ delta: {}, finish_reason: 'stop' }] },
      ],
      async () => {
        const { text, topics } = await runChatTurn(router, 'skincare?');
        expect(text).not.toContain('[[topics');
        expect(text).toContain('Sure!');
        expect(text).toContain('Use a moisturizer.');
        expect(topics).toEqual(['health']);
      },
    );
  });

  it("never leaks when a partial opener straddles the window edge across chunks", async () => {
    // The round-3 HIGH: a long preamble that ends mid-opener ("…[[") at the
    // window boundary, with the token completing in the next chunk. The
    // boundary guard must keep buffering so the token is stripped, not leaked.
    const preamble = 'x'.repeat(50);
    await withProviderStream(
      [
        { id: 't', choices: [{ delta: { content: `${preamble}[[` }, finish_reason: null }] },
        { id: 't', choices: [{ delta: { content: 'topics:health]]\n' }, finish_reason: null }] },
        { id: 't', choices: [{ delta: { content: 'Use a moisturizer.' }, finish_reason: null }] },
        { id: 't', choices: [{ delta: {}, finish_reason: 'stop' }] },
      ],
      async () => {
        const { text, topics } = await runChatTurn(router, 'skincare?');
        expect(text).not.toContain('[[topics');
        expect(text).toContain(preamble);
        expect(text).toContain('Use a moisturizer.');
        expect(topics).toEqual(['health']);
      },
    );
  });

  it("never leaks at the hard-cap boundary (long preamble + multi-char partial opener)", async () => {
    // Round-4 regression: a 113-char preamble ending in the multi-char partial
    // opener "[[topics" in chunk 1, the rest of the token in chunk 2. The
    // bounded-drain must keep the partial buffered and strip the completing
    // token end-to-end rather than latching resolved and leaking it.
    const preamble = 'x'.repeat(113);
    await withProviderStream(
      [
        { id: 't', choices: [{ delta: { content: `${preamble}[[topics` }, finish_reason: null }] },
        { id: 't', choices: [{ delta: { content: ':health]]\n' }, finish_reason: null }] },
        { id: 't', choices: [{ delta: { content: 'Use a moisturizer.' }, finish_reason: null }] },
        { id: 't', choices: [{ delta: {}, finish_reason: 'stop' }] },
      ],
      async () => {
        const { text, topics } = await runChatTurn(router, 'skincare?');
        expect(text).not.toContain('[[topics');
        expect(text).not.toContain(':health]]');
        expect(text).toContain(preamble);
        expect(text).toContain('Use a moisturizer.');
        expect(topics).toEqual(['health']);
      },
    );
  });

  it("rebases native-web-search citation offsets by the stripped token length", async () => {
    // Codex P2: citation candidates carry provider offsets into the FULL text
    // (incl. the stripped token). After stripping "[[topics:health]]\n" (18 chars)
    // the forwarded offsets must shift left by 18 so they map onto the answer.
    await withProviderStream(
      [
        { id: 't', choices: [{ delta: { content: '[[topics:health]]\n' }, finish_reason: null }] },
        { id: 't', choices: [{ delta: { content: 'The sky is blue.' }, finish_reason: null }] },
        {
          id: 't',
          choices: [{ delta: {}, finish_reason: null }],
          // "sky" sits at index 22-25 in the full text incl. the 18-char token.
          citations: [
            {
              url: 'https://example.com',
              provider: 'openai',
              providerStartIndex: 22,
              providerEndIndex: 25,
              providerText: 'sky',
            },
          ],
        },
        { id: 't', choices: [{ delta: {}, finish_reason: 'stop' }] },
      ],
      async () => {
        const { text, topics, citations } = await runChatTurn(router, 'is the sky blue?');
        expect(text).toBe('The sky is blue.');
        expect(topics).toEqual(['health']);
        expect(citations).toHaveLength(1);
        // Rebased to point at "sky" within the stripped answer (index 4-7).
        expect(citations[0].providerStartIndex).toBe(4);
        expect(citations[0].providerEndIndex).toBe(7);
        expect(text.slice(4, 7)).toBe('sky');
      },
    );
  });

  it("injects the topic-control system prompt by default", async () => {
    let captured: Array<{ role: string; content: string }> | null = null;
    const registry = await import('../providers/registry');
    (registry.createProcessor as any).mockReturnValue({
      streamChat: async function* (messages: Array<{ role: string; content: string }>) {
        captured = messages;
        yield { id: 't', choices: [{ delta: { content: 'Hi' }, finish_reason: null }] };
        yield { id: 't', choices: [{ delta: {}, finish_reason: 'stop' }] };
        return { provider: 'openai', model: 'gpt-4o' };
      },
    });
    await runChatTurn(router, 'hello');
    expect(captured![0].role).toBe('system');
    expect(captured![0].content).toContain('[[topics:');
  });

  it("omits the system prompt when CALYPSO_DISABLE_CHAT_TOPIC_TAGGING=true (kill switch)", async () => {
    process.env.CALYPSO_DISABLE_CHAT_TOPIC_TAGGING = 'true';
    let captured: Array<{ role: string; content: string }> | null = null;
    const registry = await import('../providers/registry');
    (registry.createProcessor as any).mockReturnValue({
      streamChat: async function* (messages: Array<{ role: string; content: string }>) {
        captured = messages;
        yield { id: 't', choices: [{ delta: { content: 'Hi' }, finish_reason: null }] };
        yield { id: 't', choices: [{ delta: {}, finish_reason: 'stop' }] };
        return { provider: 'openai', model: 'gpt-4o' };
      },
    });
    try {
      await runChatTurn(router, 'hello');
      expect(captured!.some((m) => m.role === 'system')).toBe(false);
    } finally {
      delete process.env.CALYPSO_DISABLE_CHAT_TOPIC_TAGGING;
    }
  });

  // -------------------------------------------------------------------
  // PII de-identification moved ENTIRELY to the client (on-device regex
  // + ONNX NER) — the enclave runs NO masking pass over chat content
  // (the Presidio sidecar was removed entirely). Consequence: the chat
  // path reaches the provider with the client-supplied content and emits
  // NO masking-related error — there is no enclave-side masker that could
  // fail and block a turn. This test is the regression guard for that
  // contract. (The previous "fails closed on masking failure" security
  // control was deliberately removed — see docs/legal/DPIA.md §masking +
  // CLAUDE.md privacy invariants.)
  // -------------------------------------------------------------------
  it("chat path runs no enclave-side masking — the turn reaches the provider unmasked-by-the-enclave", async () => {
    // Grab references to the provider-factory + adapter mocks. With
    // enclave masking removed, the chat path MUST reach the provider.
    const registry = await import("../providers/registry");
    const createProcessorMock = registry.createProcessor as ReturnType<
      typeof vi.fn
    >;
    const getProviderForModelMock = registry.getProviderForModel as ReturnType<
      typeof vi.fn
    >;
    createProcessorMock.mockClear();
    getProviderForModelMock.mockClear();

    // Replace global.fetch with a no-op spy so the mocked provider can
    // never make a real outbound request during the test.
    const fetchSpy = vi.fn();
    const origFetch = global.fetch;
    global.fetch = fetchSpy as unknown as typeof global.fetch;

    try {
      // Full handshake so the router has a live session key to try
      // decrypting the CHAT_REQUEST with. Copied verbatim from the
      // happy-path test above — we need the same setup because the
      // masking call happens AFTER decrypt.
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
      const attestPayload = JSON.parse(
        decodeFrame(attestResp!).payload.toString(),
      );

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
      const sessionId = "test-session-fail-closed";

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

      const chatPayload = JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "my email is user@example.com" }],
        stream: true,
      });
      const iv = webcrypto.getRandomValues(new Uint8Array(12));
      const encryptedPayload = Buffer.from(
        await subtle.encrypt(
          { name: "AES-GCM", iv },
          sessionKey,
          Buffer.from(chatPayload),
        ),
      );
      const ciphertext = Buffer.concat([Buffer.from(iv), encryptedPayload]);

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

      // (1) No CHAT_ERROR — with no enclave-side masker, nothing can
      //     fail-closed before the provider. The turn completes
      //     normally (CHAT_CHUNK(s) + CHAT_DONE).
      const errorFrames = responses.filter(
        (f) => decodeFrame(f).type === MSG.CHAT_ERROR,
      );
      expect(errorFrames).toHaveLength(0);
      expect(decodeFrame(responses[responses.length - 1]).type).toBe(
        MSG.CHAT_DONE,
      );

      // (2) The provider WAS reached (content forwarded as the client
      //     masked it), confirming the enclave runs no masking gate.
      expect(getProviderForModelMock).toHaveBeenCalled();
      expect(createProcessorMock).toHaveBeenCalled();
    } finally {
      global.fetch = origFetch;
    }
  });
});
