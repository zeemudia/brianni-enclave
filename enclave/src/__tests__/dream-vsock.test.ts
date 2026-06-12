import { createPublicKey, verify, webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { MSG } from "@calypso/chat-types";
import { decryptChunk, encryptChunk } from "../crypto";
import { canonicaliseEnvelopeForSigning } from "../dream/envelope-sign";
import { RecordedLlmTransport } from "../dream/llm-transport";
import { decodeFrame, encodeFrame } from "../vsock";

const subtle = webcrypto.subtle;

vi.mock("../providers/registry", () => ({
  initRegistry: vi.fn(),
  getProviderForCustomModel: vi.fn(),
  getProviderForModel: vi.fn(),
  getAllProviders: vi.fn().mockReturnValue([]),
}));

async function setupSession(router: any) {
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
  const sessionId = "dream-vsock-session";

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

  return {
    sessionId,
    sessionKey,
    signingPublicKey: kxPayload.signingPublicKey,
  };
}

describe("DREAM vsock dispatch", () => {
  it("round-trips request and finalise, producing a verifiable signed envelope", async () => {
    const record = {
      id: "mem-1",
      namespace: "default",
      baseVersion: 0,
      tombstoneEpoch: 0,
      dreamSessionId: "dream-1",
      kind: "preference",
      text: "User prefers focused mornings",
      structured: {},
      tags: ["work"],
      provenance: [
        {
          excerpt: "I prefer focused mornings",
          excerptHash: "sha256:abc",
          sourceRef: { type: "conversation", conversationId: "conv-1" },
          extractedAt: "2026-05-11T00:00:00.000Z",
          dreamSessionId: "dream-1",
        },
      ],
      confidence: 0.8,
      createdAt: "2026-05-11T00:00:00.000Z",
      updatedAt: "2026-05-11T00:00:00.000Z",
      supersededBy: null,
      visibleToUser: true,
    };
    const llmTransport = new RecordedLlmTransport([
      {
        text: JSON.stringify({
          deltas: [
            {
              action: "ADD",
              targetId: "mem-1",
              record,
              expectedBaseVersion: -1,
              mutationId: "018f7f3a-91d8-7b3d-8d9e-000000000001",
            },
          ],
        }),
        inputTokens: 1,
        outputTokens: 1,
      },
    ]);
    const { EnclaveRouter } = await import("../index");
    const router = new EnclaveRouter({ dreamLlmTransport: llmTransport });
    await router.init();
    const { sessionId, sessionKey, signingPublicKey } =
      await setupSession(router);

    const dreamRequestPlain = Buffer.from(
      JSON.stringify({
        dreamSessionId: "dream-1",
        userId: "user-1",
        namespace: "default",
        triggerKind: "nightly-consolidation",
        conversationMessages: [],
        existingMemoryRecords: [],
        preExtractedCandidates: [],
      }),
    );
    const dreamReq = encodeFrame(
      MSG.DREAM_REQUEST,
      Buffer.from(
        JSON.stringify({
          session_id: sessionId,
          ciphertext: (
            await encryptChunk(sessionKey, dreamRequestPlain)
          ).toString("base64"),
        }),
      ),
    );
    let dreamResp: Buffer | undefined;
    for await (const frame of router.handleMessage(dreamReq)) dreamResp = frame;
    const dreamFrame = decodeFrame(dreamResp!);
    expect(dreamFrame.type).toBe(MSG.DREAM_CHUNK);
    const dreamPayload = JSON.parse(
      (await decryptChunk(sessionKey, dreamFrame.payload)).toString(),
    );
    expect(dreamPayload.deltas).toHaveLength(1);

    const finaliseReq = encodeFrame(
      MSG.DREAM_FINALISE,
      Buffer.from(
        JSON.stringify({
          session_id: sessionId,
          ciphertext: (
            await encryptChunk(
              sessionKey,
              Buffer.from(
                JSON.stringify({
                  dreamSessionId: "dream-1",
                  items: [
                    {
                      deltaIndex: 0,
                      contentHash: "a".repeat(64),
                      recordSerialisedHash:
                        dreamPayload.deltas[0].recordSerialisedHash,
                    },
                  ],
                }),
              ),
            )
          ).toString("base64"),
        }),
      ),
    );
    let finaliseResp: Buffer | undefined;
    for await (const frame of router.handleMessage(finaliseReq))
      {finaliseResp = frame;}
    const finaliseFrame = decodeFrame(finaliseResp!);
    expect(finaliseFrame.type).toBe(MSG.DREAM_CHUNK);
    const finalisePayload = JSON.parse(
      (await decryptChunk(sessionKey, finaliseFrame.payload)).toString(),
    );

    expect(finalisePayload.results[0].ok).toBe(true);
    const signed = finalisePayload.results[0].signedEnvelope;
    const publicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(signingPublicKey, "base64"),
      ]),
      format: "der",
      type: "spki",
    });
    expect(
      verify(
        null,
        Buffer.from(canonicaliseEnvelopeForSigning(signed)),
        publicKey,
        Buffer.from(finalisePayload.results[0].signature, "base64"),
      ),
    ).toBe(true);

    const doneReq = encodeFrame(
      MSG.DREAM_DONE,
      Buffer.from(
        JSON.stringify({
          session_id: sessionId,
          dreamSessionId: "dream-1",
        }),
      ),
    );
    let doneResp: Buffer | undefined;
    for await (const frame of router.handleMessage(doneReq)) doneResp = frame;
    const doneFrame = decodeFrame(doneResp!);
    expect(doneFrame.type).toBe(MSG.DREAM_DONE);

    let postDoneResp: Buffer | undefined;
    for await (const frame of router.handleMessage(finaliseReq))
      {postDoneResp = frame;}
    const postDoneFrame = decodeFrame(postDoneResp!);
    expect(postDoneFrame.type).toBe(MSG.DREAM_ERROR);
    // H1: DREAM_ERROR frames are host-visible plaintext — they carry an
    // allowlisted code only, never the raw session-expiry message.
    const postDonePayload = JSON.parse(postDoneFrame.payload.toString());
    expect(postDonePayload.error_code).toBe("SESSION_EXPIRED");
    expect(postDonePayload.message).toBe("SESSION_EXPIRED");
  });
});
