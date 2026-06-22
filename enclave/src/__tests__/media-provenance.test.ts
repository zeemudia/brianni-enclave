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

  // ----- taint propagation: ANY private source taints the derivative -----
  // deriveProvenanceRecord marks the child `generated_from_private` if ANY
  // source record is private (`.some(...)`). A `.some` -> `.every` mutation
  // would only taint when ALL sources are private — a single private source
  // mixed with public ones would leak as `generated`. Mix one private + one
  // public source so `some` (taint) and `every` (no taint) disagree.
  it("propagates private taint when only one of several sources is private", () => {
    const privateParent = createProvenanceRecord(
      {
        handleId: "mh_private_src",
        kind: "image",
        origin: "user_private",
        providerVisible: false,
        sourceHandleIds: [],
        createdBy: "user-upload",
        createdAt: new Date("2026-05-19T08:00:00.000Z"),
        ttlSeconds: 900,
        byteSize: 3,
        bytes: new Uint8Array([1, 2, 3]),
      },
      signer,
    );
    const publicParent = createProvenanceRecord(
      {
        handleId: "mh_public_src",
        kind: "image",
        origin: "public",
        providerVisible: true,
        sourceHandleIds: [],
        createdBy: "stock-library",
        createdAt: new Date("2026-05-19T08:00:00.000Z"),
        ttlSeconds: 900,
        byteSize: 3,
        bytes: new Uint8Array([4, 5, 6]),
      },
      signer,
    );

    const child = deriveProvenanceRecord(
      {
        handleId: "mh_mixed_child",
        kind: "video",
        providerVisible: false,
        // order matters: public first, private second, so a buggy `every`
        // short-circuits to false on the first (public) element.
        sourceRecords: [publicParent, privateParent],
        createdBy: "core.video.remotion",
        createdAt: new Date("2026-05-19T08:01:00.000Z"),
        ttlSeconds: 900,
        byteSize: 6,
        bytes: new Uint8Array([7, 8, 9]),
      },
      signer,
    );

    expect(child.origin).toBe("generated_from_private");
  });

  // A `generated_from_private` source must ALSO taint the derivative — covers
  // the second arm of the origin OR (record.origin === "generated_from_private")
  // in deriveProvenanceRecord, which no test reached.
  it("propagates taint from a generated_from_private source", () => {
    const derivedPrivateParent = createProvenanceRecord(
      {
        handleId: "mh_gen_private",
        kind: "image",
        origin: "generated_from_private",
        providerVisible: false,
        sourceHandleIds: [],
        createdBy: "core.image.transform",
        createdAt: new Date("2026-05-19T08:00:00.000Z"),
        ttlSeconds: 900,
        byteSize: 3,
        bytes: new Uint8Array([1, 2, 3]),
      },
      signer,
    );

    const child = deriveProvenanceRecord(
      {
        handleId: "mh_grandchild",
        kind: "video",
        providerVisible: false,
        sourceRecords: [derivedPrivateParent],
        createdBy: "core.video.remotion",
        createdAt: new Date("2026-05-19T08:01:00.000Z"),
        ttlSeconds: 900,
        byteSize: 3,
        bytes: new Uint8Array([4, 5, 6]),
      },
      signer,
    );

    expect(child.origin).toBe("generated_from_private");
  });

  // All-public sources must NOT taint: child stays `generated`. Together with
  // the mixed-source test this disambiguates `some` from `every` and from the
  // constant-true/false conditional mutants on the taint predicate.
  it("does not taint a derivative when all sources are public/generated", () => {
    const publicParent = createProvenanceRecord(
      {
        handleId: "mh_public_only",
        kind: "image",
        origin: "public",
        providerVisible: true,
        sourceHandleIds: [],
        createdBy: "stock-library",
        createdAt: new Date("2026-05-19T08:00:00.000Z"),
        ttlSeconds: 900,
        byteSize: 3,
        bytes: new Uint8Array([1, 2, 3]),
      },
      signer,
    );

    const child = deriveProvenanceRecord(
      {
        handleId: "mh_public_child",
        kind: "video",
        providerVisible: true,
        sourceRecords: [publicParent],
        createdBy: "core.video.remotion",
        createdAt: new Date("2026-05-19T08:01:00.000Z"),
        ttlSeconds: 900,
        byteSize: 3,
        bytes: new Uint8Array([4, 5, 6]),
      },
      signer,
    );

    expect(child.origin).toBe("generated");
  });

  // deriveProvenanceRecord sorts and copies sourceHandleIds from its source
  // records. Pin that the child's sourceHandleIds is the sorted set of parent
  // handle ids (kills the `.map(...)` drop that would empty the lineage).
  it("records the sorted source-handle lineage on the derivative", () => {
    const a = createProvenanceRecord(
      {
        handleId: "mh_src_bbb",
        kind: "image",
        origin: "public",
        providerVisible: true,
        sourceHandleIds: [],
        createdBy: "lib",
        createdAt: new Date("2026-05-19T08:00:00.000Z"),
        ttlSeconds: 900,
        byteSize: 1,
        bytes: new Uint8Array([1]),
      },
      signer,
    );
    const b = createProvenanceRecord(
      {
        handleId: "mh_src_aaa",
        kind: "image",
        origin: "public",
        providerVisible: true,
        sourceHandleIds: [],
        createdBy: "lib",
        createdAt: new Date("2026-05-19T08:00:00.000Z"),
        ttlSeconds: 900,
        byteSize: 1,
        bytes: new Uint8Array([2]),
      },
      signer,
    );

    const child = deriveProvenanceRecord(
      {
        handleId: "mh_lineage_child",
        kind: "video",
        providerVisible: true,
        sourceRecords: [a, b],
        createdBy: "core.video.remotion",
        createdAt: new Date("2026-05-19T08:01:00.000Z"),
        ttlSeconds: 900,
        byteSize: 1,
        bytes: new Uint8Array([3]),
      },
      signer,
    );

    expect(child.sourceHandleIds).toEqual(["mh_src_aaa", "mh_src_bbb"]);
  });

  // verifyProvenanceRecord must reject a structurally invalid record up front
  // (parsed.success === false). No prior test fed an invalid record, so the
  // `if (!parsed.success) return false` guard was never exercised.
  it("rejects a structurally invalid provenance record", () => {
    const record = createProvenanceRecord(
      {
        handleId: "mh_valid",
        kind: "image",
        origin: "generated",
        providerVisible: true,
        sourceHandleIds: [],
        createdBy: "google",
        createdAt: new Date("2026-05-19T08:00:00.000Z"),
        ttlSeconds: 900,
        byteSize: 1,
        bytes: new Uint8Array([7]),
      },
      signer,
    );

    // ttlSeconds = 0 violates the schema (positive int required) -> safeParse
    // fails -> verify returns false without even reaching expiry/hash checks.
    const malformed = { ...record, ttlSeconds: 0 };
    expect(
      verifyProvenanceRecord(
        malformed as typeof record,
        new Uint8Array([7]),
        signer,
        new Date("2026-05-19T08:00:05.000Z"),
      ),
    ).toBe(false);
  });

  // Expiry is `now > expiresAt` (strict). At EXACTLY expiresAt the record is
  // still valid; one millisecond past it is expired. Pins the `>` boundary so
  // `>` -> `>=` (which would reject a record exactly at its expiry instant) is
  // killed.
  it("treats a record as valid at exactly its expiry instant and invalid one ms later", () => {
    const createdAt = new Date("2026-05-19T08:00:00.000Z");
    const record = createProvenanceRecord(
      {
        handleId: "mh_expiry",
        kind: "image",
        origin: "generated",
        providerVisible: true,
        sourceHandleIds: [],
        createdBy: "google",
        createdAt,
        ttlSeconds: 10,
        byteSize: 1,
        bytes: new Uint8Array([7]),
      },
      signer,
    );
    const expiresAt = createdAt.getTime() + 10 * 1000;

    expect(
      verifyProvenanceRecord(record, new Uint8Array([7]), signer, new Date(expiresAt)),
    ).toBe(true);
    expect(
      verifyProvenanceRecord(
        record,
        new Uint8Array([7]),
        signer,
        new Date(expiresAt + 1),
      ),
    ).toBe(false);
  });

  // verifyProvenanceRecord must reject a record whose signature does not verify
  // (kills the `return signer.verify(...)` -> `return true` mutant).
  it("rejects a record with a tampered signature", () => {
    const record = createProvenanceRecord(
      {
        handleId: "mh_sig",
        kind: "image",
        origin: "generated",
        providerVisible: true,
        sourceHandleIds: [],
        createdBy: "google",
        createdAt: new Date("2026-05-19T08:00:00.000Z"),
        ttlSeconds: 900,
        byteSize: 1,
        bytes: new Uint8Array([7]),
      },
      signer,
    );
    // Re-sign over different bytes: a valid signature, but for the wrong record.
    const wrongSignature = signer.sign("not-the-canonical-payload");

    expect(
      verifyProvenanceRecord(
        { ...record, signature: wrongSignature },
        new Uint8Array([7]),
        signer,
        new Date("2026-05-19T08:00:05.000Z"),
      ),
    ).toBe(false);
  });

  // ----- classifyProvenanceSet aggregation -----
  // taint is private if ANY record is private (`some`), providerVisible is true
  // if ANY record is provider-visible (`some`). Mixed sets disambiguate
  // `some` from `every` on both fields.
  it("classifies a mixed set as private when only one record is private", () => {
    const publicRecord = createProvenanceRecord(
      {
        handleId: "mh_pub",
        kind: "image",
        origin: "public",
        providerVisible: false,
        sourceHandleIds: [],
        createdBy: "lib",
        createdAt: new Date("2026-05-19T08:00:00.000Z"),
        ttlSeconds: 900,
        byteSize: 1,
        bytes: new Uint8Array([1]),
      },
      signer,
    );
    const privateRecord = createProvenanceRecord(
      {
        handleId: "mh_priv",
        kind: "image",
        origin: "user_private",
        providerVisible: false,
        sourceHandleIds: [],
        createdBy: "user",
        createdAt: new Date("2026-05-19T08:00:00.000Z"),
        ttlSeconds: 900,
        byteSize: 1,
        bytes: new Uint8Array([2]),
      },
      signer,
    );

    expect(classifyProvenanceSet([publicRecord, privateRecord]).taint).toBe(
      "private",
    );
  });

  it("classifies a set containing a generated_from_private record as private", () => {
    const derivedPrivate = createProvenanceRecord(
      {
        handleId: "mh_gen_priv_cls",
        kind: "image",
        origin: "generated_from_private",
        providerVisible: false,
        sourceHandleIds: [],
        createdBy: "core.image.transform",
        createdAt: new Date("2026-05-19T08:00:00.000Z"),
        ttlSeconds: 900,
        byteSize: 1,
        bytes: new Uint8Array([1]),
      },
      signer,
    );

    expect(classifyProvenanceSet([derivedPrivate]).taint).toBe("private");
  });

  it("classifies an all-public set as public_or_generated", () => {
    const publicRecord = createProvenanceRecord(
      {
        handleId: "mh_pub_only",
        kind: "image",
        origin: "public",
        providerVisible: true,
        sourceHandleIds: [],
        createdBy: "lib",
        createdAt: new Date("2026-05-19T08:00:00.000Z"),
        ttlSeconds: 900,
        byteSize: 1,
        bytes: new Uint8Array([1]),
      },
      signer,
    );

    expect(classifyProvenanceSet([publicRecord]).taint).toBe(
      "public_or_generated",
    );
  });

  it("reports providerVisible=true when at least one record is provider-visible", () => {
    const hidden = createProvenanceRecord(
      {
        handleId: "mh_hidden",
        kind: "image",
        origin: "public",
        providerVisible: false,
        sourceHandleIds: [],
        createdBy: "lib",
        createdAt: new Date("2026-05-19T08:00:00.000Z"),
        ttlSeconds: 900,
        byteSize: 1,
        bytes: new Uint8Array([1]),
      },
      signer,
    );
    const visible = createProvenanceRecord(
      {
        handleId: "mh_visible",
        kind: "image",
        origin: "public",
        providerVisible: true,
        sourceHandleIds: [],
        createdBy: "lib",
        createdAt: new Date("2026-05-19T08:00:00.000Z"),
        ttlSeconds: 900,
        byteSize: 1,
        bytes: new Uint8Array([2]),
      },
      signer,
    );

    // hidden first so a buggy `every` short-circuits false on the first element.
    expect(classifyProvenanceSet([hidden, visible]).providerVisible).toBe(true);
    expect(classifyProvenanceSet([hidden]).providerVisible).toBe(false);
  });
});
