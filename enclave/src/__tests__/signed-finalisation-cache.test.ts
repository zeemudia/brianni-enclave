import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

import {
  EnclaveSessionManager,
  MEMORY_WRITE_ACK_TIMEOUT_MS,
  type SignedFinalisationEntry,
} from "../session";

async function newSession(): Promise<{
  mgr: EnclaveSessionManager;
  sessionId: string;
}> {
  const mgr = new EnclaveSessionManager();
  const sessionId = "sess_" + Math.random().toString(36).slice(2);
  const attest = await mgr.handleAttestation(new Uint8Array(16));
  const teePubB64 = Buffer.from(attest.ephemeralPublicKey).toString("base64");
  // Client-side ECDH to establish a session — reuse Node webcrypto.
  const { webcrypto } = await import("node:crypto");
  const clientKp = await webcrypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const clientPubRaw = new Uint8Array(
    await webcrypto.subtle.exportKey("raw", clientKp.publicKey),
  );
  await mgr.handleKeyExchange(
    clientPubRaw,
    sessionId,
    new Uint8Array(32),
    teePubB64,
  );
  return { mgr, sessionId };
}

function fakeEntry(
  overrides: Partial<SignedFinalisationEntry> = {},
): SignedFinalisationEntry {
  return {
    signedEnvelope: { kind: "fact", v: 1 } as never,
    signature: "sig_" + Math.random().toString(36).slice(2),
    contentHash: "ch_" + Math.random().toString(36).slice(2),
    recordSerialisedHash: "rsh_" + Math.random().toString(36).slice(2),
    signedAt: Date.now(),
    pendingClientAck: true,
    signedBlobB64: Buffer.from("canonical").toString("base64"),
    ...overrides,
  };
}

describe("signedFinalisationCache (chunk H Wave 3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cacheSignedFinalisation stores under (agentTurnId, invocationId)", async () => {
    const { mgr, sessionId } = await newSession();
    const entry = fakeEntry();
    await mgr.cacheSignedFinalisation(sessionId, "turn1", "inv1", entry);
    const found = await mgr.lookupSignedFinalisation(
      sessionId,
      "turn1",
      "inv1",
    );
    expect(found).not.toBeNull();
    expect(found!.signature).toBe(entry.signature);
  });

  it("lookupSignedFinalisation returns null for unknown (turn, invocation)", async () => {
    const { mgr, sessionId } = await newSession();
    const found = await mgr.lookupSignedFinalisation(
      sessionId,
      "turn1",
      "inv1",
    );
    expect(found).toBeNull();
  });

  it("ackSignedFinalisation deletes entry on matching contentHash, returns 'ok'", async () => {
    const { mgr, sessionId } = await newSession();
    const entry = fakeEntry({ contentHash: "H_A" });
    await mgr.cacheSignedFinalisation(sessionId, "turn1", "inv1", entry);
    const r = await mgr.ackSignedFinalisation(
      sessionId,
      "turn1",
      "inv1",
      "H_A",
    );
    expect(r.outcome).toBe("ok");
    const found = await mgr.lookupSignedFinalisation(
      sessionId,
      "turn1",
      "inv1",
    );
    expect(found).toBeNull();
  });

  it("ackSignedFinalisation REJECTS mismatched contentHash and preserves entry", async () => {
    const { mgr, sessionId } = await newSession();
    const entry = fakeEntry({ contentHash: "H_A" });
    await mgr.cacheSignedFinalisation(sessionId, "turn1", "inv1", entry);
    const r = await mgr.ackSignedFinalisation(
      sessionId,
      "turn1",
      "inv1",
      "H_B",
    );
    expect(r.outcome).toBe("mismatch");
    const found = await mgr.lookupSignedFinalisation(
      sessionId,
      "turn1",
      "inv1",
    );
    expect(found).not.toBeNull();
    expect(found!.contentHash).toBe("H_A");
  });

  it("ackSignedFinalisation is idempotent — second ACK on already-deleted entry returns 'absent'", async () => {
    const { mgr, sessionId } = await newSession();
    const entry = fakeEntry({ contentHash: "H_A" });
    await mgr.cacheSignedFinalisation(sessionId, "turn1", "inv1", entry);
    const r1 = await mgr.ackSignedFinalisation(
      sessionId,
      "turn1",
      "inv1",
      "H_A",
    );
    expect(r1.outcome).toBe("ok");
    const r2 = await mgr.ackSignedFinalisation(
      sessionId,
      "turn1",
      "inv1",
      "H_A",
    );
    expect(r2.outcome).toBe("absent");
  });

  it("cache expires after MEMORY_WRITE_ACK_TIMEOUT_MS — replay returns null", async () => {
    const { mgr, sessionId } = await newSession();
    // Put the entry's signedAt in the past directly rather than advancing
    // wall-clock time — the session TTL is also 5 min, so a time advance
    // would expire the session along with the cache.
    const entry = fakeEntry({
      signedAt: Date.now() - MEMORY_WRITE_ACK_TIMEOUT_MS - 1,
    });
    await mgr.cacheSignedFinalisation(sessionId, "turn1", "inv1", entry);
    const found = await mgr.lookupSignedFinalisation(
      sessionId,
      "turn1",
      "inv1",
    );
    expect(found).toBeNull();
  });

  it("clearAgentTurn drops every invocation under the turn", async () => {
    const { mgr, sessionId } = await newSession();
    await mgr.cacheSignedFinalisation(sessionId, "turn1", "inv1", fakeEntry());
    await mgr.cacheSignedFinalisation(sessionId, "turn1", "inv2", fakeEntry());
    await mgr.cacheSignedFinalisation(sessionId, "turn2", "inv3", fakeEntry());
    await mgr.clearAgentTurn(sessionId, "turn1");
    expect(
      await mgr.lookupSignedFinalisation(sessionId, "turn1", "inv1"),
    ).toBeNull();
    expect(
      await mgr.lookupSignedFinalisation(sessionId, "turn1", "inv2"),
    ).toBeNull();
    expect(
      await mgr.lookupSignedFinalisation(sessionId, "turn2", "inv3"),
    ).not.toBeNull();
  });

  it("zeroSession clears signedFinalisationCache alongside other state", async () => {
    const { mgr, sessionId } = await newSession();
    await mgr.cacheSignedFinalisation(sessionId, "turn1", "inv1", fakeEntry());
    await mgr.zeroSession(sessionId);
    // After zero, any operation throws the typed session-expired error
    // (M2: SESSION_EXPIRED token so the wire error_code maps honestly).
    await expect(
      mgr.lookupSignedFinalisation(sessionId, "turn1", "inv1"),
    ).rejects.toThrow(/SESSION_EXPIRED/);
  });

  it("MEMORY_WRITE_ACK_TIMEOUT_MS is exported and defaults to 5 minutes", () => {
    expect(MEMORY_WRITE_ACK_TIMEOUT_MS).toBe(5 * 60 * 1000);
  });

  it("rejects ackSignedFinalisation against an expired session", async () => {
    const { mgr, sessionId } = await newSession();
    await mgr.zeroSession(sessionId);
    await expect(
      mgr.ackSignedFinalisation(sessionId, "turn1", "inv1", "H_A"),
    ).rejects.toThrow(/SESSION_EXPIRED/);
  });

  // R11 Finding B (Codex): if a memory.write signs late in a long
  // turn, the session must stay alive at least MEMORY_WRITE_ACK_TIMEOUT_MS
  // past the signing event — even when that pushes past the normal
  // 5-min session TTL. Without this, getSessionEntry would zero the
  // session before the cache's own retry window expires.
  it("cacheSignedFinalisation extends the effective session TTL by MEMORY_WRITE_ACK_TIMEOUT_MS past signedAt", async () => {
    const { mgr, sessionId } = await newSession();
    // Sign at "now"; the cache must outlive the standard 5-min session
    // TTL. Simulate by caching with a signedAt that's 4 minutes into
    // the session and then advancing the clock past the 5-min mark
    // but BEFORE the cache's signedAt + 5min expiry.
    const baseNow = Date.now();
    const entry = fakeEntry({ signedAt: baseNow + 4 * 60 * 1000 });
    await mgr.cacheSignedFinalisation(sessionId, "turn1", "inv1", entry);
    // Jump to 6 minutes — past the original 5-min session TTL, but
    // still well within the cache's signedAt + 5min retry window.
    vi.setSystemTime(baseNow + 6 * 60 * 1000);
    const found = await mgr.lookupSignedFinalisation(
      sessionId,
      "turn1",
      "inv1",
    );
    expect(found).not.toBeNull();
    expect(found!.signature).toBe(entry.signature);
  });

  it("AGENT_REQUEST finally MUST NOT clear signedFinalisationCache (codex finding #3, R8-H1)", async () => {
    // Source-level guard: the AGENT_REQUEST handler's finally block
    // must NOT call clearAgentTurn. Cache deletion is owned by ACK
    // (matching contentHash), MEMORY_WRITE_ACK_TIMEOUT_MS expiry
    // sweep, or zeroSession — never by stream teardown. Without this
    // invariant, the post-sign network-drop recovery the cache exists
    // for cannot work.
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const indexSrc = readFileSync(
      resolve(here, "../index.ts"),
      "utf8",
    );
    // Locate the AGENT_REQUEST handler.
    const start = indexSrc.indexOf("case MSG.AGENT_REQUEST");
    const end = indexSrc.indexOf("case MSG.TOOL_RESULT", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = indexSrc.slice(start, end);
    // Allow the explanatory comment that mentions the name; reject any
    // ACTUAL call (a call would be `.clearAgentTurn(` or `sessionManager.clearAgentTurn(`).
    expect(block).not.toMatch(/\.clearAgentTurn\s*\(/);
    expect(block).not.toMatch(/sessionManager\.clearAgentTurn/);
  });

  it("cross-turn isolation — turn-A invocation cannot be replayed under turn-B id", async () => {
    const { mgr, sessionId } = await newSession();
    const entryA = fakeEntry({ contentHash: "H_A" });
    await mgr.cacheSignedFinalisation(sessionId, "turnA", "inv1", entryA);
    // Same invocationId under a different turn → not found
    const found = await mgr.lookupSignedFinalisation(
      sessionId,
      "turnB",
      "inv1",
    );
    expect(found).toBeNull();
  });
});
