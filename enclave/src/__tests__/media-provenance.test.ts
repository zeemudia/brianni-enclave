import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  classifyProvenanceSet,
  createProvenanceRecord,
  deriveProvenanceRecord,
  verifyProvenanceRecord,
} from "../media/provenance";

const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const signer = {
  sign: (canonical: string) =>
    sign(null, Buffer.from(canonical), createPrivateKey(privateKey)).toString("base64"),
  verify: (canonical: string, signatureB64: string) =>
    verify(
      null,
      Buffer.from(canonical),
      createPublicKey(publicKey),
      Buffer.from(signatureB64, "base64"),
    ),
};

describe("media provenance", () => {
  it("creates and verifies enclave-signed provenance", () => {
    const record = createProvenanceRecord(
      {
        handleId: "mh_private",
        kind: "text",
        origin: "user_private",
        providerVisible: false,
        sourceHandleIds: [],
        createdBy: "test",
        createdAt: new Date("2026-05-19T08:00:00.000Z"),
        ttlSeconds: 900,
        byteSize: 12,
        bytes: new TextEncoder().encode("private text"),
      },
      signer,
    );

    expect(
      verifyProvenanceRecord(
        record,
        new TextEncoder().encode("private text"),
        signer,
        new Date("2026-05-19T08:05:00.000Z"),
      ),
    ).toBe(true);
    expect(record.sha256).toBe(
      createHash("sha256").update(new TextEncoder().encode("private text")).digest("hex"),
    );
  });

  it("propagates private taint to derived handles", () => {
    const parent = createProvenanceRecord(
      {
        handleId: "mh_private",
        kind: "image",
        origin: "user_private",
        providerVisible: false,
        sourceHandleIds: [],
        createdBy: "user-upload",
        createdAt: new Date("2026-05-19T08:00:00.000Z"),
        ttlSeconds: 900,
        byteSize: 8,
        bytes: new Uint8Array([1, 2, 3]),
      },
      signer,
    );

    const child = deriveProvenanceRecord(
      {
        handleId: "mh_child",
        kind: "video",
        providerVisible: false,
        sourceRecords: [parent],
        createdBy: "core.video.remotion",
        createdAt: new Date("2026-05-19T08:01:00.000Z"),
        ttlSeconds: 900,
        byteSize: 64,
        bytes: new Uint8Array([4, 5, 6]),
      },
      signer,
    );

    expect(child.origin).toBe("generated_from_private");
    expect(classifyProvenanceSet([parent, child]).taint).toBe("private");
  });

  it("fails closed for expired and tampered provenance", () => {
    const record = createProvenanceRecord(
      {
        handleId: "mh_generated",
        kind: "image",
        origin: "generated",
        providerVisible: true,
        sourceHandleIds: [],
        createdBy: "google",
        createdAt: new Date("2026-05-19T08:00:00.000Z"),
        ttlSeconds: 10,
        byteSize: 1,
        bytes: new Uint8Array([7]),
      },
      signer,
    );

    expect(
      verifyProvenanceRecord(
        record,
        new Uint8Array([7]),
        signer,
        new Date("2026-05-19T08:00:05.000Z"),
      ),
    ).toBe(true);
    expect(
      verifyProvenanceRecord(
        record,
        new Uint8Array([7]),
        signer,
        new Date("2026-05-19T08:00:11.000Z"),
      ),
    ).toBe(false);
    expect(
      verifyProvenanceRecord(
        { ...record, origin: "public" },
        new Uint8Array([7]),
        signer,
        new Date("2026-05-19T08:00:05.000Z"),
      ),
    ).toBe(false);
    expect(
      verifyProvenanceRecord(
        record,
        new Uint8Array([8]),
        signer,
        new Date("2026-05-19T08:00:05.000Z"),
      ),
    ).toBe(false);
  });
});
