import { describe, expect, it } from "vitest";
import {
  CrossPackGrantBodySchema,
  CrossPackGrantEnvelopeSchema,
  MAX_GRANT_DOCUMENTS,
  computeGrantCommitment,
  type CrossPackGrantBody,
} from "../cross-pack-grant";

// NB: must satisfy every CrossPackGrantBodySchema constraint (nonce >= 8
// chars, etc.) — strict-mode tests below rely on this fixture being
// otherwise-valid so the ONLY parse failure is the one under test.
const body: CrossPackGrantBody = {
  namespaces: ["money", "health"],
  folderIds: ["f1", "f2"],
  documentIds: ["d1"],
  nonce: "n-123-456",
};

describe("computeGrantCommitment", () => {
  it("is deterministic and key-order independent", () => {
    const a = computeGrantCommitment(body, { mode: "jit", expiresAt: 1000 });
    const b = computeGrantCommitment(
      { folderIds: ["f1", "f2"], documentIds: ["d1"], nonce: "n-123-456", namespaces: ["money", "health"] },
      { expiresAt: 1000, mode: "jit" },
    );
    expect(a).toBe(b);
    const c = computeGrantCommitment(
      { ...body, namespaces: ["health", "money"], folderIds: ["f2", "f1"] },
      { mode: "jit", expiresAt: 1000 },
    );
    expect(a).toBe(c);
  });

  it("changes if any committed field changes", () => {
    const base = computeGrantCommitment(body, { mode: "jit", expiresAt: 1000 });
    expect(computeGrantCommitment(body, { mode: "jit", expiresAt: 1001 })).not.toBe(base);
    expect(
      computeGrantCommitment({ ...body, namespaces: ["money"] }, { mode: "jit", expiresAt: 1000 }),
    ).not.toBe(base);
    expect(
      computeGrantCommitment({ ...body, nonce: "other" }, { mode: "jit", expiresAt: 1000 }),
    ).not.toBe(base);
    expect(
      computeGrantCommitment({ ...body, folderIds: ["f1", "f99"] }, { mode: "jit", expiresAt: 1000 }),
    ).not.toBe(base);
    expect(
      computeGrantCommitment({ ...body, documentIds: ["d2"] }, { mode: "jit", expiresAt: 1000 }),
    ).not.toBe(base);
    expect(computeGrantCommitment(body, { mode: "durable", expiresAt: 1000 })).not.toBe(base);
  });
});

describe("schemas", () => {
  it("body rejects an empty namespaces array", () => {
    expect(() => CrossPackGrantBodySchema.parse({ ...body, namespaces: [] })).toThrow();
  });
  it("envelope requires a 64-hex commit and a positive expiresAt", () => {
    expect(() =>
      CrossPackGrantEnvelopeSchema.parse({
        grantId: "g1", commit: "zz", healthVerified: false, mode: "jit", expiresAt: 1,
      }),
    ).toThrow();
  });
  it("M-3: envelope rejects an unknown/extra key (strict mode)", () => {
    // The envelope always has exactly grantId/commit/healthVerified/mode/expiresAt.
    // A smuggled extra key must cause a loud parse rejection rather than silent strip.
    const validEnvelope = {
      grantId: "g1",
      commit: "a".repeat(64),
      healthVerified: false,
      mode: "jit" as const,
      expiresAt: 9999999999,
    };
    // Sanity: valid envelope parses fine
    expect(() => CrossPackGrantEnvelopeSchema.parse(validEnvelope)).not.toThrow();
    // Extra key must be rejected
    expect(() =>
      CrossPackGrantEnvelopeSchema.parse({ ...validEnvelope, extraField: "smuggled" }),
    ).toThrow();
  });
  it("M-3: body is strict — extra body key is rejected with unrecognized_keys", () => {
    // Belt-and-suspenders: the body schema rejects extra keys too, and the
    // rejection must be FOR the extra key (unrecognized_keys), not a
    // coincidental failure on another field. A previous version of this test
    // passed only because the fixture's nonce was shorter than min(8) — it
    // stayed green even with a .passthrough() body schema.
    expect(() => CrossPackGrantBodySchema.parse(body)).not.toThrow();
    const r = CrossPackGrantBodySchema.safeParse({ ...body, extraBodyField: "smuggled" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.code)).toContain("unrecognized_keys");
    }
  });
});

describe("MAX_GRANT_DOCUMENTS", () => {
  it("is exported and equals 64", () => {
    expect(MAX_GRANT_DOCUMENTS).toBe(64);
  });
});
