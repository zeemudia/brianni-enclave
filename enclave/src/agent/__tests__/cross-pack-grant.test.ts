import { describe, expect, it } from "vitest";
import {
  computeGrantCommitment,
  MAX_AGENT_LINKED_FOLDERS,
  MAX_GRANT_DOCUMENTS,
  type CrossPackGrantBody,
} from "@calypso/chat-types";
import { resolveCrossPackGrant, type ResolvedCrossPackGrant } from "../cross-pack-grant";

function assertOk(
  r: ResolvedCrossPackGrant,
): asserts r is Extract<ResolvedCrossPackGrant, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got reject: ${r.reason}`);
}

const CLAIMS = { id: "personal-agent.claims", defaultNamespace: "default",
  crossPackNamespaces: ["default", "work", "money", "health"] } as const;
const DEFAULT_PACK = { id: "personal-agent.default", defaultNamespace: "default" } as const;

const body: CrossPackGrantBody = {
  namespaces: ["money", "health"], folderIds: ["f1"], documentIds: [], nonce: "nonce-abcd",
};
const future = Date.now() + 60_000;
function envelope(over = {}) {
  return { grantId: "g1", commit: computeGrantCommitment(body, { mode: "jit", expiresAt: future }),
    healthVerified: true, mode: "jit" as const, expiresAt: future, ...over };
}

describe("resolveCrossPackGrant", () => {
  it("no grant → single-namespace authorization (unchanged default)", () => {
    const r = resolveCrossPackGrant({ pack: DEFAULT_PACK, envelope: undefined, body: undefined, now: Date.now() });
    expect(r.ok).toBe(true);
    assertOk(r);
    expect([...r.namespaces]).toEqual(["default"]);
  });

  it("valid grant on claims → union intersected with crossPackNamespaces", () => {
    const r = resolveCrossPackGrant({ pack: CLAIMS, envelope: envelope(), body, now: Date.now() });
    expect(r.ok).toBe(true);
    assertOk(r);
    expect(new Set(r.namespaces)).toEqual(new Set(["money", "health"]));
    expect(new Set(r.folderIds)).toEqual(new Set(["f1"]));
  });

  it("purpose binding: grant ignored when active pack is NOT claims", () => {
    const r = resolveCrossPackGrant({ pack: DEFAULT_PACK, envelope: envelope(), body, now: Date.now() });
    expect(r.ok).toBe(true);
    assertOk(r);
    expect([...r.namespaces]).toEqual(["default"]); // grant inert
  });

  it("commitment mismatch → reject", () => {
    const r = resolveCrossPackGrant({
      pack: CLAIMS, envelope: envelope({ commit: "0".repeat(64) }), body, now: Date.now() });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("GRANT_COMMITMENT_MISMATCH");
  });

  it("expired grant → reject", () => {
    const past = Date.now() - 1000;
    const r = resolveCrossPackGrant({
      pack: CLAIMS,
      envelope: envelope({ expiresAt: past, commit: computeGrantCommitment(body, { mode: "jit", expiresAt: past }) }),
      body, now: Date.now() });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("GRANT_EXPIRED");
  });

  it("healthVerified=false drops health but keeps the rest", () => {
    const env = envelope({ healthVerified: false });
    const r = resolveCrossPackGrant({ pack: CLAIMS, envelope: env, body, now: Date.now() });
    expect(r.ok).toBe(true);
    assertOk(r);
    expect(new Set(r.namespaces)).toEqual(new Set(["money"])); // health dropped
  });

  it("a namespace outside crossPackNamespaces is dropped", () => {
    const b2: CrossPackGrantBody = { ...body, namespaces: ["money", "relationships"], nonce: "nonce-wxyz" };
    const env = { grantId: "g2", commit: computeGrantCommitment(b2, { mode: "jit", expiresAt: future }),
      healthVerified: true, mode: "jit" as const, expiresAt: future };
    const r = resolveCrossPackGrant({ pack: CLAIMS, envelope: env, body: b2, now: Date.now() });
    expect(r.ok).toBe(true);
    assertOk(r);
    expect(new Set(r.namespaces)).toEqual(new Set(["money"])); // relationships not in crossPackNamespaces
  });

  it("only-health body with healthVerified=false collapses to single default", () => {
    const b: CrossPackGrantBody = { ...body, namespaces: ["health"], nonce: "nonce-only-health" };
    const env = { grantId: "g3",
      commit: computeGrantCommitment(b, { mode: "jit", expiresAt: future }),
      healthVerified: false, mode: "jit" as const, expiresAt: future };
    const r = resolveCrossPackGrant({ pack: CLAIMS, envelope: env, body: b, now: Date.now() });
    assertOk(r);
    expect([...r.namespaces]).toEqual(["default"]); // collapsed, no widening
  });

  it("envelope present but body missing → reject (no silent widening)", () => {
    const r = resolveCrossPackGrant({ pack: CLAIMS, envelope: envelope(), body: undefined, now: Date.now() });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("GRANT_BODY_MISSING");
  });

  // 1C.3 — oversize folder-set hard reject
  it("folderIds.length === MAX_AGENT_LINKED_FOLDERS (32) → still ok (boundary, not rejected)", () => {
    const bigFolderIds = Array.from({ length: MAX_AGENT_LINKED_FOLDERS }, (_, i) => `folder-${i}`);
    const bigBody: CrossPackGrantBody = { ...body, folderIds: bigFolderIds, nonce: "nonce-big-ok" };
    const bigEnv = {
      grantId: "g-big",
      commit: computeGrantCommitment(bigBody, { mode: "jit", expiresAt: future }),
      healthVerified: true,
      mode: "jit" as const,
      expiresAt: future,
    };
    const r = resolveCrossPackGrant({ pack: CLAIMS, envelope: bigEnv, body: bigBody, now: Date.now() });
    expect(r.ok).toBe(true);
    assertOk(r);
    expect(r.folderIds.size).toBe(MAX_AGENT_LINKED_FOLDERS);
  });

  it("folderIds.length === MAX_AGENT_LINKED_FOLDERS + 1 (33) → ok: false, reason GRANT_TOO_MANY_FOLDERS", () => {
    const oversizeFolderIds = Array.from({ length: MAX_AGENT_LINKED_FOLDERS + 1 }, (_, i) => `folder-${i}`);
    const oversizeBody: CrossPackGrantBody = { ...body, folderIds: oversizeFolderIds, nonce: "nonce-oversize" };
    const oversizeEnv = {
      grantId: "g-oversize",
      commit: computeGrantCommitment(oversizeBody, { mode: "jit", expiresAt: future }),
      healthVerified: true,
      mode: "jit" as const,
      expiresAt: future,
    };
    const r = resolveCrossPackGrant({ pack: CLAIMS, envelope: oversizeEnv, body: oversizeBody, now: Date.now() });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("GRANT_TOO_MANY_FOLDERS");
  });

  // FIX B — documentIds array-length bound (GRANT_TOO_MANY_DOCUMENTS)

  it("documentIds.length === MAX_GRANT_DOCUMENTS (64) → still ok (boundary, not rejected)", () => {
    const bigDocIds = Array.from({ length: MAX_GRANT_DOCUMENTS }, (_, i) => `doc-${i}`);
    const bigBody: CrossPackGrantBody = { ...body, documentIds: bigDocIds, nonce: "nonce-big-docs-ok" };
    const bigEnv = {
      grantId: "g-big-docs",
      commit: computeGrantCommitment(bigBody, { mode: "jit", expiresAt: future }),
      healthVerified: true,
      mode: "jit" as const,
      expiresAt: future,
    };
    const r = resolveCrossPackGrant({ pack: CLAIMS, envelope: bigEnv, body: bigBody, now: Date.now() });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.documentIds.size).toBe(MAX_GRANT_DOCUMENTS);
  });

  it("documentIds.length === MAX_GRANT_DOCUMENTS + 1 (65) → ok: false, reason GRANT_TOO_MANY_DOCUMENTS", () => {
    const oversizeDocIds = Array.from({ length: MAX_GRANT_DOCUMENTS + 1 }, (_, i) => `doc-${i}`);
    const oversizeBody: CrossPackGrantBody = {
      ...body,
      documentIds: oversizeDocIds,
      nonce: "nonce-oversize-docs",
    };
    const oversizeEnv = {
      grantId: "g-oversize-docs",
      commit: computeGrantCommitment(oversizeBody, { mode: "jit", expiresAt: future }),
      healthVerified: true,
      mode: "jit" as const,
      expiresAt: future,
    };
    const r = resolveCrossPackGrant({ pack: CLAIMS, envelope: oversizeEnv, body: oversizeBody, now: Date.now() });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("GRANT_TOO_MANY_DOCUMENTS");
  });
});
