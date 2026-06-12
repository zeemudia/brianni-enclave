import { describe, it, expect, beforeEach, vi } from "vitest";
import { EnclaveSessionManager } from "../session";
import { createPublicKey, verify, webcrypto } from "node:crypto";

const subtle = webcrypto.subtle;

describe("EnclaveSessionManager", () => {
  let manager: EnclaveSessionManager;

  beforeEach(() => {
    manager = new EnclaveSessionManager();
  });

  describe("attestation keypair", () => {
    it("generates ephemeral ECDH keypair on attestation request", async () => {
      const nonce = webcrypto.getRandomValues(new Uint8Array(32));
      const result = await manager.handleAttestation(nonce);

      expect(result.ephemeralPublicKey).toBeInstanceOf(Uint8Array);
      expect(result.ephemeralPublicKey.length).toBeGreaterThan(0);
      expect(result.nonce).toEqual(nonce);
    });

    it("generates the ECDH private key NON-extractable", async () => {
      // Node provides no API to zero WebCrypto/OpenSSL-held private key
      // material (neither CryptoKey nor KeyObject has destroy()), so the
      // strongest available guarantee is that no code path can ever export
      // the ECDH scalar: the key must be generated non-extractable and
      // disposal relies on dropping references + GC within the keypair TTL.
      const spy = vi.spyOn(subtle, "generateKey");
      const nonce = webcrypto.getRandomValues(new Uint8Array(32));
      await manager.handleAttestation(nonce);

      const ecdhCall = spy.mock.calls.find(
        (call) => (call[0] as EcKeyGenParams).name === "ECDH",
      );
      expect(ecdhCall).toBeDefined();
      expect(ecdhCall![1]).toBe(false); // extractable
      spy.mockRestore();
    });

    it("rotates keypair on new attestation request", async () => {
      const nonce1 = webcrypto.getRandomValues(new Uint8Array(32));
      const nonce2 = webcrypto.getRandomValues(new Uint8Array(32));

      const result1 = await manager.handleAttestation(nonce1);
      const result2 = await manager.handleAttestation(nonce2);

      expect(
        Buffer.from(result1.ephemeralPublicKey).equals(
          Buffer.from(result2.ephemeralPublicKey),
        ),
      ).toBe(false);
    });
  });

  describe("key exchange", () => {
    it("derives session key from client public key + nonces", async () => {
      const attestNonce = webcrypto.getRandomValues(new Uint8Array(32));
      const attestResult = await manager.handleAttestation(attestNonce);
      const teePubB64 = Buffer.from(attestResult.ephemeralPublicKey).toString(
        "base64",
      );

      const clientKeyPair = await subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveBits"],
      );
      const clientPubRaw = new Uint8Array(
        await subtle.exportKey("raw", clientKeyPair.publicKey),
      );
      const clientNonce = webcrypto.getRandomValues(new Uint8Array(32));
      const sessionId = "test-session-1";

      const ack = await manager.handleKeyExchange(
        clientPubRaw,
        sessionId,
        clientNonce,
        teePubB64,
      );

      expect(ack.teeKeyExchangeNonce).toBeInstanceOf(Uint8Array);
      expect(ack.teeKeyExchangeNonce.length).toBe(32);
      expect(ack.sessionId).toBe(sessionId);
      expect(ack.signingPublicKey).toBeInstanceOf(Uint8Array);
      expect(ack.signingPublicKey.length).toBe(32);
    });

    it("allows only one concurrent key exchange for a single attested TEE keypair", async () => {
      const attestNonce = webcrypto.getRandomValues(new Uint8Array(32));
      const attestResult = await manager.handleAttestation(attestNonce);
      const teePubB64 = Buffer.from(attestResult.ephemeralPublicKey).toString(
        "base64",
      );

      const clientKeyPair = await subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveBits"],
      );
      const clientPubRaw = new Uint8Array(
        await subtle.exportKey("raw", clientKeyPair.publicKey),
      );

      const attempts = await Promise.allSettled([
        manager.handleKeyExchange(
          clientPubRaw,
          "race-session-1",
          webcrypto.getRandomValues(new Uint8Array(32)),
          teePubB64,
        ),
        manager.handleKeyExchange(
          clientPubRaw,
          "race-session-2",
          webcrypto.getRandomValues(new Uint8Array(32)),
          teePubB64,
        ),
      ]);

      expect(
        attempts.filter((attempt) => attempt.status === "fulfilled"),
      ).toHaveLength(1);
      const rejected = attempts.find(
        (attempt) => attempt.status === "rejected",
      );
      expect(rejected?.reason).toEqual(
        expect.objectContaining({
          message: expect.stringMatching(/No attestation keypair found/),
        }),
      );
    });

    it("signEnvelope signs with a per-session Ed25519 key that verifies under the ACK public key", async () => {
      const attestNonce = webcrypto.getRandomValues(new Uint8Array(32));
      const attestResult = await manager.handleAttestation(attestNonce);
      const teePubB64 = Buffer.from(attestResult.ephemeralPublicKey).toString(
        "base64",
      );

      const clientKeyPair = await subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveBits"],
      );
      const clientPubRaw = new Uint8Array(
        await subtle.exportKey("raw", clientKeyPair.publicKey),
      );
      const clientNonce = webcrypto.getRandomValues(new Uint8Array(32));
      const sessionId = "test-signing-session";

      const ack = await manager.handleKeyExchange(
        clientPubRaw,
        sessionId,
        clientNonce,
        teePubB64,
      );
      const canonicalEnvelope = JSON.stringify({
        action: "ADD",
        blobId: "mem-1",
        v: 1,
      });
      const signature = await manager.signEnvelope(
        sessionId,
        canonicalEnvelope,
      );
      const spki = Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(ack.signingPublicKey),
      ]);
      const publicKey = createPublicKey({
        key: spki,
        format: "der",
        type: "spki",
      });

      expect(signature).toBeInstanceOf(Uint8Array);
      expect(signature.length).toBe(64);
      expect(
        verify(null, Buffer.from(canonicalEnvelope), publicKey, signature),
      ).toBe(true);
    });

    it("session key can encrypt/decrypt", async () => {
      const attestNonce = webcrypto.getRandomValues(new Uint8Array(32));
      const attestResult = await manager.handleAttestation(attestNonce);
      const teePubB64 = Buffer.from(attestResult.ephemeralPublicKey).toString(
        "base64",
      );

      const clientKeyPair = await subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveBits"],
      );
      const clientPubRaw = new Uint8Array(
        await subtle.exportKey("raw", clientKeyPair.publicKey),
      );
      const clientNonce = webcrypto.getRandomValues(new Uint8Array(32));

      await manager.handleKeyExchange(
        clientPubRaw,
        "sess-1",
        clientNonce,
        teePubB64,
      );
      const sessionKey = await manager.getSessionKey("sess-1");

      const iv = webcrypto.getRandomValues(new Uint8Array(12));
      const ct = await subtle.encrypt(
        { name: "AES-GCM", iv },
        sessionKey,
        Buffer.from("test"),
      );
      expect(ct.byteLength).toBeGreaterThan(0);
    });
  });

  describe("session cleanup", () => {
    it("zeroes session key on zeroSession()", async () => {
      const attestNonce = webcrypto.getRandomValues(new Uint8Array(32));
      const attestResult = await manager.handleAttestation(attestNonce);
      const teePubB64 = Buffer.from(attestResult.ephemeralPublicKey).toString(
        "base64",
      );

      const clientKeyPair = await subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveBits"],
      );
      const clientPubRaw = new Uint8Array(
        await subtle.exportKey("raw", clientKeyPair.publicKey),
      );
      const clientNonce = webcrypto.getRandomValues(new Uint8Array(32));

      await manager.handleKeyExchange(
        clientPubRaw,
        "sess-cleanup",
        clientNonce,
        teePubB64,
      );
      await manager.zeroSession("sess-cleanup");

      await expect(manager.getSessionKey("sess-cleanup")).rejects.toThrow(
        /session.*not.*found|expired/i,
      );
      await expect(manager.signEnvelope("sess-cleanup", "{}")).rejects.toThrow(
        /session.*not.*found|expired/i,
      );
    });
  });
});
