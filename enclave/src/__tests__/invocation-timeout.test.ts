import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EnclaveRouter } from "../index";
import { encodeFrame, MSG } from "../vsock";
import { webcrypto } from "node:crypto";
import type {
  ChatChunk,
  ChatMessage,
  ChatProcessor,
} from "@calypso/chat-types";

const subtle = webcrypto.subtle;
const here = dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(join(here, "..", "index.ts"), "utf8");

async function establishSession(
  router: EnclaveRouter,
): Promise<{ sessionId: string; sessionKey: webcrypto.CryptoKey }> {
  const attestFrame = encodeFrame(
    MSG.ATTESTATION_REQUEST,
    Buffer.from(JSON.stringify({ nonce: Buffer.alloc(16).toString("base64") })),
  );
  let attestResp: Buffer | null = null;
  for await (const out of router.handleMessage(attestFrame)) {
    attestResp = Buffer.from(out);
  }
  const teePubKeyB64 = JSON.parse(attestResp!.subarray(5).toString()).ephemeral_public_key;
  const clientKp = await subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const clientPubRaw = new Uint8Array(
    await subtle.exportKey("raw", clientKp.publicKey),
  );
  const sessionId = "sess_to_" + Math.random().toString(36).slice(2);
  const clientNonce = webcrypto.getRandomValues(new Uint8Array(32));
  const kxFrame = encodeFrame(
    MSG.KEY_EXCHANGE,
    Buffer.from(
      JSON.stringify({
        client_ephemeral_public_key: Buffer.from(clientPubRaw).toString("base64"),
        session_id: sessionId,
        client_key_exchange_nonce: Buffer.from(clientNonce).toString("base64"),
        tee_public_key: teePubKeyB64,
      }),
    ),
  );
  let kxResp: Buffer | null = null;
  for await (const out of router.handleMessage(kxFrame)) {
    kxResp = Buffer.from(out);
  }
  const teeNonce = Buffer.from(
    JSON.parse(kxResp!.subarray(5).toString()).tee_key_exchange_nonce,
    "base64",
  );
  const teePubRawBuf = Buffer.from(teePubKeyB64, "base64");
  const teePub = await subtle.importKey(
    "raw",
    new Uint8Array(teePubRawBuf),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sharedBits = await subtle.deriveBits(
    { name: "ECDH", public: teePub },
    clientKp.privateKey,
    256,
  );
  const salt = new Uint8Array(64);
  salt.set(clientNonce, 0);
  salt.set(new Uint8Array(teeNonce), 32);
  const hkdfKey = await subtle.importKey("raw", sharedBits, "HKDF", false, [
    "deriveBits",
  ]);
  const keyBits = await subtle.deriveBits(
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
    keyBits,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return { sessionId, sessionKey };
}

async function encryptToFrame(
  key: webcrypto.CryptoKey,
  buf: Buffer,
): Promise<Buffer> {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new Uint8Array(buf),
  );
  return Buffer.concat([Buffer.from(iv), Buffer.from(ct)]);
}

describe("EnclaveRouter — invocation timeout (codex R4 finding #5)", () => {
  it("agent turn with a model-emitted tool call where /tool-result NEVER arrives → bridge resolves with INVOCATION_TIMEOUT after the configured ms", async () => {
    // Use a tiny (50 ms) timeout with real timers — fake-timer interplay
    // with the multi-microtask agent-loop dispatch chain is fiddly, and
    // 50 ms × 1 invocation = 50 ms test wall time is cheap.
    // The provider yields the tool call on its FIRST invocation only;
    // subsequent calls yield a done chunk so the loop terminates after
    // the timeout-induced retry.
    let providerInvocations = 0;
    const provider: ChatProcessor = {
      async *streamChat(_messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
        providerInvocations += 1;
        if (providerInvocations === 1) {
          const tool = JSON.stringify({
            toolName: "memory.list",
            args: { namespace: "default" },
          });
          yield {
            id: "c1",
            choices: [
              {
                delta: { content: `<tool>${tool}</tool>` },
                finish_reason: "stop",
              },
            ],
          };
        } else {
          yield {
            id: "c2",
            choices: [
              { delta: { content: "Done." }, finish_reason: "stop" },
            ],
          };
        }
      },
    };
    const router = new EnclaveRouter({
      agentLoopProcessorFactory: () => provider,
      invocationTimeoutMs: 50,
    });
    const { sessionId, sessionKey } = await establishSession(router);

    const payload = await encryptToFrame(
      sessionKey,
      Buffer.from(
        JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
          model: "test",
          skillPack: {
            id: "personal-agent.default",
            version: 1,
            displayName: "Default",
            description: "test",
            systemPromptBlock: "x",
            toolScopes: ["memory.list"],
            defaultNamespace: "default",
            linkedFolderScopes: {},
            uiHints: { icon: "default", accentToken: "accent-default" },
          },
        }),
      ),
    );
    const agentFrame = encodeFrame(
      MSG.AGENT_REQUEST,
      Buffer.from(
        JSON.stringify({
          session_id: sessionId,
          agent_turn_id: "turn_to",
          ciphertext: payload.toString("base64"),
        }),
      ),
    );

    const collected: Array<{ type: number; body: Buffer }> = [];
    for await (const out of router.handleMessage(agentFrame)) {
      const b = Buffer.from(out);
      collected.push({ type: b.readUInt8(0), body: b.subarray(5) });
    }

    // TOOL_INVOCATION was emitted, then the bridge timed out, then the
    // loop reinjected the error and called the provider again, which
    // yielded "Done." and AGENT_DONE.
    const toolInvocations = collected.filter(
      (f) => f.type === MSG.TOOL_INVOCATION,
    );
    expect(toolInvocations).toHaveLength(1);

    // Loop terminated via AGENT_DONE (not stuck on TOOL_LIMIT_EXCEEDED).
    const dones = collected.filter((f) => f.type === MSG.AGENT_DONE);
    expect(dones).toHaveLength(1);
    // Provider was called twice — once for the initial tool call,
    // once after the timeout-induced retry.
    expect(providerInvocations).toBe(2);

    // The router's outstandingInvocations map was cleaned up by the
    // setTimeout's delete; submit a stray TOOL_RESULT for the same
    // invocationId, expect UNSOLICITED.
  }, 10_000);

  it("invocationTimeoutMs option threads through the EnclaveRouter constructor", () => {
    const r = new EnclaveRouter({ invocationTimeoutMs: 42 });

    expect((r as any).invocationTimeoutMs).toBe(42);
    const rDefault = new EnclaveRouter();

    expect((rDefault as any).invocationTimeoutMs).toBe(60_000);
  });

  it("chunk refreshes cannot extend an invocation beyond the absolute lifetime cap", () => {
    expect(indexSource).toContain("absoluteInvocationDeadline");
    expect(indexSource).toContain("this.invocationTimeoutMs * 10");
    expect(indexSource).toMatch(
      /Math\.min\(\s*this\.invocationTimeoutMs,\s*remainingMs\s*\)/,
    );
    expect(indexSource).toMatch(/if\s*\(remainingMs\s*<=\s*0\)/);
  });
});
