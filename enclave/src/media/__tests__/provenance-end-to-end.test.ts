import { describe, expect, it } from "vitest";
import {
  verifyMediaProvenance,
  extractMediaProvenancePublicKey,
} from "@calypso/nitro-verify";
import { createProvenanceRecord } from "../provenance";
import { deriveProvenanceSigner, buildProvenanceUserData } from "../provenance-key";

// End-to-end: the REAL enclave signing path (createProvenanceRecord using the
// HKDF-derived stable signer) must produce a record the client verifier
// (packages/nitro-verify) accepts against the published raw public key. This
// proves the two canonicalisers agree and the attestation-rooted key round-trips.
const MEDIA_ROOT_SECRET = Buffer.from(
  "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
  "hex",
);

describe("media provenance end-to-end (enclave sign → client verify)", () => {
  const bytes = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90]);
  const now = new Date("2026-06-13T12:00:00.000Z");

  it("a record signed by the derived signer verifies with the client verifier", async () => {
    const { signer, publicKeyRaw } = deriveProvenanceSigner(MEDIA_ROOT_SECRET);
    const record = createProvenanceRecord(
      {
        handleId: "mh_e2eimage01",
        kind: "image",
        origin: "generated",
        providerVisible: true,
        sourceHandleIds: [],
        createdBy: "gpt-image-2",
        createdAt: now,
        ttlSeconds: 3600,
        byteSize: bytes.byteLength,
        bytes,
      },
      signer,
    );
    const ok = await verifyMediaProvenance({
      record,
      bytes,
      provenancePublicKey: publicKeyRaw,
      now: now.getTime() + 60_000,
    });
    expect(ok).toBe(true);
  });

  it("the public key published in user_data is the one that verifies the record", async () => {
    const { signer, publicKeyRaw } = deriveProvenanceSigner(MEDIA_ROOT_SECRET);
    const record = createProvenanceRecord(
      {
        handleId: "mh_e2eimage02",
        kind: "image",
        origin: "generated",
        providerVisible: true,
        sourceHandleIds: [],
        createdBy: "gemini-2.5-flash-image",
        createdAt: now,
        ttlSeconds: 3600,
        byteSize: bytes.byteLength,
        bytes,
      },
      signer,
    );
    // Round-trip through the exact user_data envelope the attestation publishes.
    const userData = buildProvenanceUserData(publicKeyRaw);
    const extracted = extractMediaProvenancePublicKey(userData);
    expect(extracted).not.toBeNull();
    const ok = await verifyMediaProvenance({
      record,
      bytes,
      provenancePublicKey: extracted!,
      now: now.getTime() + 60_000,
    });
    expect(ok).toBe(true);
  });

  it("a record signed by a DIFFERENT boot's secret does NOT verify (tamper / wrong identity)", async () => {
    const { signer } = deriveProvenanceSigner(MEDIA_ROOT_SECRET);
    const other = deriveProvenanceSigner(Buffer.from(MEDIA_ROOT_SECRET).fill(0));
    const record = createProvenanceRecord(
      {
        handleId: "mh_e2eimage03",
        kind: "image",
        origin: "generated",
        providerVisible: true,
        sourceHandleIds: [],
        createdBy: "gpt-image-2",
        createdAt: now,
        ttlSeconds: 3600,
        byteSize: bytes.byteLength,
        bytes,
      },
      signer,
    );
    const ok = await verifyMediaProvenance({
      record,
      bytes,
      provenancePublicKey: other.publicKeyRaw,
      now: now.getTime() + 60_000,
    });
    expect(ok).toBe(false);
  });
});
