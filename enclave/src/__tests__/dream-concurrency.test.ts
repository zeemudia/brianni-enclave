/**
 * B8 — Dream concurrency + collision (enclave half).
 *
 * Spec (docs/launch/agent-capability-verification.md §3 B8): two concurrent
 * sessions writing the same record → CAS `expectedBaseVersion` mismatch
 * rejected, no double-ADD; duplicate candidates within one run deduped by
 * reconcile.
 *
 * Where enforcement actually lives (the spec's literal
 * `DELTA_BASE_VERSION_MISMATCH` code exists nowhere in the codebase):
 *   - The CAS apply itself is SERVER-side: `cas_conflict` /
 *     `cas_conflict_race` (server/src/routes/blobs-memory.ts:660,703) via
 *     `updateMany WHERE recordVersion = expectedBaseVersion`, and double-ADD
 *     via `memory_blob_already_exists` (:624). The enclave's contribution to
 *     CAS soundness is ARITHMETIC: every signed envelope must carry
 *     `newRecordVersion === expectedBaseVersion + 1` (0 for ADD) so the
 *     server can only ever apply one of two writes prepared from the same
 *     stale snapshot. These tests pin that arithmetic under genuinely
 *     interleaved sessions.
 *   - No double-ADD: ADD blob ids + mutationIds are enclave-minted per delta
 *     (enclave/src/dream/index.ts:121-128), and a prepared envelope is
 *     single-use at finalisation (enclave/src/dream/envelope-sign.ts:92).
 *   - Dedup of duplicate candidates within one run is delegated to the
 *     reconcile LLM prompt (enclave/src/dream/reconcile.ts:58-62) and
 *     enforced behaviourally by the dream-eval ≥95% precision gate — there
 *     is NO code-level dedup. The prompt contract is pinned here.
 */
import { describe, expect, it } from "vitest";

import { runDreamSession } from "../dream";
import {
  canonicaliseEnvelopeForSigning,
  finaliseDreamEnvelopes,
} from "../dream/envelope-sign";
import type {
  LlmRequest,
  LlmResponse,
  LlmTransport,
} from "../dream/llm-transport";
import type {
  CandidateMemory,
  DreamCandidate,
  UnsignedEnvelope,
} from "../dream/types";
import { canonicaliseMemoryWrite } from "../tools/tier-b-draft";
import type {
  MemoryRecord,
  SkillPack,
  ToolInvocationFrame,
} from "@calypso/chat-types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem-shared",
    namespace: "default",
    baseVersion: 1,
    tombstoneEpoch: 0,
    dreamSessionId: "dream-orig",
    kind: "fact",
    text: "The user works a four-day week.",
    structured: {},
    tags: ["work"],
    provenance: [
      {
        excerpt: "I work a four-day week",
        excerptHash: "sha256:abcdef01",
        sourceRef: { type: "conversation", conversationId: "conv-1" },
        extractedAt: "2026-06-01T00:00:00.000Z",
        dreamSessionId: "dream-orig",
      },
    ],
    confidence: 0.9,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    supersededBy: null,
    visibleToUser: true,
    ...overrides,
  };
}

function candidateMemory(text = "User works a four-day week"): CandidateMemory {
  return {
    namespace: "default",
    kind: "fact",
    text,
    structured: {},
    tags: ["work"],
    provenance: [
      {
        excerpt: text,
        excerptHash: "sha256:abc",
        sourceRef: { type: "conversation", conversationId: "conv-1" },
        extractedAt: "2026-06-12T00:00:00.000Z",
        dreamSessionId: "dream-x",
      },
    ],
    confidence: 0.8,
  };
}

function makeCandidate(
  dreamSessionId: string,
  existing: MemoryRecord[],
): DreamCandidate {
  return {
    triggerKind: "reconcile-only",
    dreamSessionId,
    userId: "user-1",
    namespace: "default",
    conversationMessages: [],
    existingMemoryRecords: existing,
    preExtractedCandidates: [candidateMemory()],
  };
}

/**
 * A transport whose single `complete()` resolution is held until the test
 * releases it — this forces a REAL interleave: session A issues its
 * reconcile call, session B issues and completes its entire run, then A's
 * model response (computed from the now-stale snapshot) arrives.
 */
function deferredTransport() {
  let resolveResponse!: (r: LlmResponse) => void;
  const gate = new Promise<LlmResponse>((resolve) => {
    resolveResponse = resolve;
  });
  const requests: LlmRequest[] = [];
  const transport: LlmTransport = {
    async complete(req: LlmRequest): Promise<LlmResponse> {
      requests.push({ ...req });
      return gate;
    },
  };
  return {
    transport,
    requests,
    release(text: string) {
      resolveResponse({ text, inputTokens: 1, outputTokens: 1 });
    },
  };
}

function updateDeltaJson(mutationId: string): string {
  return JSON.stringify({
    deltas: [
      {
        action: "UPDATE",
        targetId: "mem-shared",
        // Both sessions read the record at baseVersion 1, so both claim 1.
        expectedBaseVersion: 1,
        mutationId,
        record: makeRecord({ baseVersion: 2, text: "Updated fact text." }),
      },
    ],
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------
// 1. Concurrent sessions, same record, stale base version
// ---------------------------------------------------------------------------

describe("dream concurrency: two sessions writing the same record", () => {
  it("interleaved UPDATEs from the same stale snapshot both stay CAS-bound to expectedBaseVersion+1 (no silent version bump)", async () => {
    const shared = makeRecord(); // baseVersion 1 — the snapshot BOTH sessions read
    const a = deferredTransport();
    const b = deferredTransport();

    // Start A first, then B; complete B first, then A. A's reconcile output
    // is now stale: B's write (if applied) advanced the record to version 2.
    const pA = runDreamSession({
      candidate: makeCandidate("dream-A", [shared]),
      llmTransport: a.transport,
    });
    const pB = runDreamSession({
      candidate: makeCandidate("dream-B", [shared]),
      llmTransport: b.transport,
    });

    b.release(updateDeltaJson("00000000-0000-4000-8000-0000000000b1"));
    const outB = await pB;
    a.release(updateDeltaJson("00000000-0000-4000-8000-0000000000a1"));
    const outA = await pA;

    for (const out of [outA, outB]) {
      expect(out.deltas).toHaveLength(1);
      const delta = out.deltas[0];
      // The CAS-soundness arithmetic the server relies on: both envelopes
      // target the SAME current version (1) and the SAME next version (2).
      // The server's `updateMany WHERE recordVersion = 1` therefore applies
      // exactly one; the loser gets 409 cas_conflict (the implementation of
      // the spec's "DELTA_BASE_VERSION_MISMATCH rejected").
      expect(delta.delta.expectedBaseVersion).toBe(1);
      expect(delta.delta.record?.baseVersion).toBe(2);
      expect(delta.delta.targetId).toBe("mem-shared");
      expect(delta.recordSerialisedHash).toMatch(/^[a-f0-9]{64}$/);
    }

    // The enclave must NOT have "helpfully" rebased the late session onto a
    // newer version — a silent bump would turn the CAS into last-writer-wins.
    expect(outA.deltas[0].delta.expectedBaseVersion).toBe(
      outB.deltas[0].delta.expectedBaseVersion,
    );

    // Each session keeps its own identity: distinct enclave-minted
    // mutationIds (so the server can tell the two writes apart) and the
    // record body is stamped with the authentic per-session dreamSessionId.
    expect(outA.deltas[0].delta.mutationId).toMatch(UUID_RE);
    expect(outB.deltas[0].delta.mutationId).toMatch(UUID_RE);
    expect(outA.deltas[0].delta.mutationId).not.toBe(
      outB.deltas[0].delta.mutationId,
    );
    expect(outA.deltas[0].delta.record?.dreamSessionId).toBe("dream-A");
    expect(outB.deltas[0].delta.record?.dreamSessionId).toBe("dream-B");
  });

  it("concurrent ADDs of the same logical fact mint distinct blob ids and mutationIds (no save-time collision, no shared replay key)", async () => {
    const a = deferredTransport();
    const b = deferredTransport();
    const addJson = JSON.stringify({
      deltas: [
        {
          action: "ADD",
          targetId: "new-id", // dummy per the reconcile prompt contract
          expectedBaseVersion: -1,
          mutationId: "00000000-0000-4000-8000-00000000add1",
          record: makeRecord({ id: "new-id", baseVersion: 0 }),
        },
      ],
    });

    const pA = runDreamSession({
      candidate: makeCandidate("dream-A", []),
      llmTransport: a.transport,
    });
    const pB = runDreamSession({
      candidate: makeCandidate("dream-B", []),
      llmTransport: b.transport,
    });
    b.release(addJson);
    a.release(addJson);
    const [outA, outB] = await Promise.all([pA, pB]);

    const dA = outA.deltas[0].delta;
    const dB = outB.deltas[0].delta;
    // ADD ids are enclave-minted (dream/index.ts:127-128): two concurrent
    // sessions can never collide on blobId (`memory_blob_already_exists`)
    // nor alias each other's mutation replay key. Note: this means the SAME
    // fact extracted by two concurrent sessions becomes two records — by
    // design; cross-session dedup is nightly consolidation's job, not CAS's.
    expect(dA.targetId).toMatch(UUID_RE);
    expect(dB.targetId).toMatch(UUID_RE);
    expect(dA.targetId).not.toBe(dB.targetId);
    expect(dA.mutationId).not.toBe(dB.mutationId);
    expect(dA.record?.id).toBe(dA.targetId);
    expect(dB.record?.id).toBe(dB.targetId);
    expect(dA.record?.baseVersion).toBe(0);
    expect(dB.record?.baseVersion).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Duplicate candidates within one run
// ---------------------------------------------------------------------------

describe("dream concurrency: duplicate candidates within one run", () => {
  it("duplicate ADD deltas in one reconcile response get distinct enclave-minted identities, and the dedup contract is pinned in the reconcile prompt", async () => {
    // There is NO code-level dedup in the dream pipeline: "duplicate
    // candidates deduped by reconcile" (B8 spec) is implemented as a
    // reconcile-prompt instruction plus the dream-eval precision CI gate.
    // This test pins (a) the prompt instruction that carries that duty and
    // (b) that a model which FAILS to dedup still cannot cause a save-time
    // collision (distinct ids / distinct replay keys — the failure mode is
    // a redundant record, not a conflict or a double-apply).
    const t = deferredTransport();
    const dupRecord = makeRecord({ id: "new-id", baseVersion: 0 });
    const p = runDreamSession({
      candidate: makeCandidate("dream-dup", []),
      llmTransport: t.transport,
    });
    t.release(
      JSON.stringify({
        deltas: [
          {
            action: "ADD",
            targetId: "new-id",
            expectedBaseVersion: -1,
            mutationId: "00000000-0000-4000-8000-00000000d0d0",
            record: dupRecord,
          },
          {
            action: "ADD",
            targetId: "new-id",
            expectedBaseVersion: -1,
            mutationId: "00000000-0000-4000-8000-00000000d0d0", // model dup
            record: dupRecord,
          },
        ],
      }),
    );
    const out = await p;

    expect(out.deltas).toHaveLength(2);
    const [d0, d1] = out.deltas.map((d) => d.delta);
    expect(d0.targetId).not.toBe(d1.targetId);
    expect(d0.mutationId).not.toBe(d1.mutationId);
    expect(d0.mutationId).toMatch(UUID_RE);
    expect(d1.mutationId).toMatch(UUID_RE);

    // The prompt-level dedup contract — the only in-enclave surface for the
    // spec's "deduped by reconcile". If this wording is ever dropped, the
    // dream-eval precision gate is the lone remaining guard.
    const systemPrompt = t.requests[0].systemPrompt;
    expect(systemPrompt).toContain("find near-duplicate records");
    expect(systemPrompt).toContain("never emit spurious deltas");
    expect(systemPrompt).toContain("Only emit deltas for namespace: default");
  });
});

// ---------------------------------------------------------------------------
// 3. Concurrent finalisation (the enclave's no-double-apply surface)
// ---------------------------------------------------------------------------

const CONTENT_HASH = "a".repeat(64);
const RECORD_HASH = "b".repeat(64);

function makeUnsigned(
  dreamSessionId: string,
  blobId: string,
  createdAt: number,
): UnsignedEnvelope {
  return {
    createdAt,
    recordSerialisedHash: RECORD_HASH,
    envelopeFields: {
      v: 1,
      userId: "user-1",
      namespace: "default",
      blobId,
      action: "ADD",
      expectedBaseVersion: -1,
      newRecordVersion: 0,
      kind: "fact",
      mutationId: crypto.randomUUID(),
      dreamSessionId,
      teeSessionId: "tee-1",
      provenanceConversationIds: ["conv-1"],
      issuedAt: "2026-06-12T00:00:00.000Z",
      expiresAt: "2026-06-12T00:01:00.000Z",
    },
  };
}

/** signEnvelope that yields the microtask queue, exposing interleave windows. */
async function yieldingSign(canonical: string): Promise<Uint8Array> {
  await new Promise((resolve) => setImmediate(resolve));
  return new Uint8Array(Buffer.from(canonical.slice(0, 8)));
}

describe("dream concurrency: interleaved envelope finalisation", () => {
  it("two sessions finalising concurrently each sign only their own envelopes (per-session state isolation)", async () => {
    const state = {
      inFlightUnsignedEnvelopes: new Map([
        ["dream-A", new Map([[0, makeUnsigned("dream-A", "blob-a", 1000)]])],
        ["dream-B", new Map([[0, makeUnsigned("dream-B", "blob-b", 1000)]])],
      ]),
    };

    const [resA, resB] = await Promise.all([
      finaliseDreamEnvelopes({
        state,
        dreamSessionId: "dream-A",
        items: [
          { deltaIndex: 0, contentHash: CONTENT_HASH, recordSerialisedHash: RECORD_HASH },
        ],
        signEnvelope: yieldingSign,
        now: () => 1000,
      }),
      finaliseDreamEnvelopes({
        state,
        dreamSessionId: "dream-B",
        items: [
          { deltaIndex: 0, contentHash: CONTENT_HASH, recordSerialisedHash: RECORD_HASH },
        ],
        signEnvelope: yieldingSign,
        now: () => 1000,
      }),
    ]);

    expect(resA[0].ok).toBe(true);
    expect(resB[0].ok).toBe(true);
    if (!resA[0].ok || !resB[0].ok) throw new Error("expected ok results");
    expect(resA[0].signedEnvelope.blobId).toBe("blob-a");
    expect(resA[0].signedEnvelope.dreamSessionId).toBe("dream-A");
    expect(resB[0].signedEnvelope.blobId).toBe("blob-b");
    expect(resB[0].signedEnvelope.dreamSessionId).toBe("dream-B");
    // Neither call consumed (or signed) the other session's envelope.
    expect(state.inFlightUnsignedEnvelopes.get("dream-A")?.size).toBe(0);
    expect(state.inFlightUnsignedEnvelopes.get("dream-B")?.size).toBe(0);
  });

  it("racing duplicate finalise calls for the same delta can never produce two DISTINCT applyable envelopes", async () => {
    // Sequential double-finalise is already pinned to `unknown_delta_index`
    // (dream-envelope-sign.test.ts:78). The CONCURRENT variant interleaves at
    // the async signEnvelope await — both calls read the unsigned entry
    // before either deletes it, so both can return ok. That is benign ONLY
    // because the prepared envelope is immutable at finalise time: the two
    // signed envelopes are byte-identical (same mutationId, same blobId,
    // same newRecordVersion), so the server's mutation replay check and ADD
    // blobId uniqueness (blobs-memory.ts:125-142, :624) collapse them into
    // one apply. If finalisation ever re-minted mutationId/issuedAt per
    // call, this test MUST fail — that would be a real double-ADD vector.
    const state = {
      inFlightUnsignedEnvelopes: new Map([
        ["dream-A", new Map([[0, makeUnsigned("dream-A", "blob-a", 1000)]])],
      ]),
    };
    const request = {
      state,
      dreamSessionId: "dream-A",
      items: [
        { deltaIndex: 0, contentHash: CONTENT_HASH, recordSerialisedHash: RECORD_HASH },
      ],
      signEnvelope: yieldingSign,
      now: () => 1000,
    };

    const [first, second] = await Promise.all([
      finaliseDreamEnvelopes(request),
      finaliseDreamEnvelopes(request),
    ]);

    const oks = [first[0], second[0]].filter(
      (r): r is Extract<typeof r, { ok: true }> => r.ok,
    );
    expect(oks.length).toBeGreaterThanOrEqual(1);
    if (oks.length === 2) {
      // Double-signed, but indistinguishable on the wire: one apply max.
      expect(oks[0].envelopeJson).toBe(oks[1].envelopeJson);
      expect(oks[0].signedEnvelope.mutationId).toBe(
        oks[1].signedEnvelope.mutationId,
      );
      expect(oks[0].envelopeJson).toBe(
        canonicaliseEnvelopeForSigning(oks[0].signedEnvelope),
      );
    }
    // Either way the entry is consumed; a third attempt is a hard miss.
    const third = await finaliseDreamEnvelopes(request);
    expect(third[0]).toEqual({
      ok: false,
      deltaIndex: 0,
      error: "unknown_delta_index",
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Agent-path memory.write — same CAS arithmetic under concurrent turns
// ---------------------------------------------------------------------------

const careerPack: SkillPack = {
  id: "personal-agent.career",
  version: 1,
  displayName: "Career",
  description: "Career pack.",
  systemPromptBlock: "Career mode.",
  toolScopes: ["memory.list", "memory.read", "memory.write"],
  capabilitySuiteIds: ["text"],
  defaultNamespace: "work",
  linkedFolderScopes: {},
  uiHints: { icon: "briefcase", accentToken: "accent-blue" },
};

describe("dream concurrency: agent memory.write CAS arithmetic", () => {
  it("two turns preparing UPDATEs from the same snapshot produce envelopes the server CAS can only apply once", () => {
    const record = makeRecord({ id: "m1", namespace: "work", baseVersion: 3 });
    const makeFrame = (invocationId: string): ToolInvocationFrame => ({
      invocationId,
      agentTurnId: `turn_${invocationId}`,
      toolName: "memory.write",
      args: {
        delta: {
          action: "UPDATE",
          targetId: "m1",
          record,
          expectedBaseVersion: 3, // both turns read version 3
          mutationId: "00000000-0000-4000-8000-000000000000",
        },
      },
    });

    const r1 = canonicaliseMemoryWrite(
      makeFrame("inv1"),
      careerPack,
      { userId: "u1", sessionId: "sess1", agentTurnId: "turn_inv1" },
      { now: 1_000_000, mutationId: "00000000-0000-4000-8000-000000000101" },
    );
    const r2 = canonicaliseMemoryWrite(
      makeFrame("inv2"),
      careerPack,
      { userId: "u1", sessionId: "sess1", agentTurnId: "turn_inv2" },
      { now: 1_000_000, mutationId: "00000000-0000-4000-8000-000000000202" },
    );

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) throw new Error("expected ok canonicalisation");

    for (const prepared of [r1.prepared, r2.prepared]) {
      // newRecordVersion = expectedBaseVersion + 1: the invariant that lets
      // the server's `WHERE recordVersion = 3` guard reject the second
      // writer with cas_conflict instead of double-applying.
      expect(prepared.envelopeFields.expectedBaseVersion).toBe(3);
      expect(prepared.envelopeFields.newRecordVersion).toBe(4);
      expect(prepared.envelopeFields.blobId).toBe("m1");
      expect(prepared.canonicalRecord?.baseVersion).toBe(4);
    }
    // Distinct gateway-minted mutationIds — the writes are distinguishable,
    // so the CAS loser is a clean conflict, never a replay of the winner.
    expect(r1.prepared.envelopeFields.mutationId).not.toBe(
      r2.prepared.envelopeFields.mutationId,
    );
  });
});
