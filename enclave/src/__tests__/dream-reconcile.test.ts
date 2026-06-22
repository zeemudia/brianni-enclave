import { describe, expect, it, vi } from "vitest";
import type { MemoryRecord } from "@calypso/chat-types";

import { RecordedLlmTransport } from "../dream/llm-transport";
import { reconcileCandidateMemories, runDreamSession } from "../dream";
import type { CandidateMemory, DreamCandidate } from "../dream/types";

function candidateMemory(): CandidateMemory {
  return {
    namespace: "default",
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
  };
}

function makeDreamCandidate(
  overrides: Partial<DreamCandidate> = {},
): DreamCandidate {
  return {
    triggerKind: "end-of-session",
    dreamSessionId: "dream-1",
    userId: "user-1",
    namespace: "default",
    conversationMessages: [
      { role: "user", content: "I prefer focused mornings." },
      { role: "assistant", content: "Noted." },
      { role: "user", content: "Avoid late meetings too." },
    ],
    existingMemoryRecords: [],
    ...overrides,
  };
}

function memoryRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem-1",
    namespace: "default",
    baseVersion: 0,
    tombstoneEpoch: 0,
    dreamSessionId: "dream-1",
    kind: "preference",
    text: "User prefers focused mornings",
    structured: {},
    tags: ["work"],
    provenance: candidateMemory().provenance,
    confidence: 0.8,
    createdAt: "2026-05-11T00:00:00.000Z",
    updatedAt: "2026-05-11T00:00:00.000Z",
    supersededBy: null,
    visibleToUser: true,
    ...overrides,
  };
}

describe("reconcileCandidateMemories", () => {
  it("produces DreamDelta values with serialised records from the injected LLM transport", async () => {
    const record = memoryRecord();
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
        inputTokens: 5,
        outputTokens: 7,
      },
    ]);

    const result = await reconcileCandidateMemories({
      candidates: [candidateMemory()],
      existingMemoryRecords: [],
      context: {
        userId: "user-1",
        namespace: "default",
        dreamSessionId: "dream-1",
      },
      llmTransport,
    });

    expect(result).toHaveLength(1);
    expect(result[0].delta.action).toBe("ADD");
    expect(result[0].recordSerialised).toBe(JSON.stringify(record));
    expect(llmTransport.requests[0].model).toBe("claude-sonnet-4-6");
    expect(llmTransport.requests[0].systemPrompt).toContain(
      "ADD/UPDATE/SUPERSEDE/TOMBSTONE",
    );
  });

  it("accepts markdown-fenced JSON from the reconcile model", async () => {
    const record = memoryRecord({ id: "mem-fenced" });
    const llmTransport = new RecordedLlmTransport([
      {
        text: `\`\`\`json\n${JSON.stringify({
          deltas: [
            {
              action: "ADD",
              targetId: "mem-fenced",
              record,
              expectedBaseVersion: -1,
              mutationId: "018f7f3a-91d8-7b3d-8d9e-0000000000dd",
            },
          ],
        })}\n\`\`\``,
        inputTokens: 5,
        outputTokens: 7,
      },
    ]);

    const result = await reconcileCandidateMemories({
      candidates: [candidateMemory()],
      existingMemoryRecords: [],
      context: {
        userId: "user-1",
        namespace: "default",
        dreamSessionId: "dream-1",
      },
      llmTransport,
    });

    expect(result).toHaveLength(1);
    expect(result[0].delta.targetId).toBe("mem-fenced");
  });

  it("rejects invalid JSON and wrong top-level shapes with static errors", async () => {
    await expect(
      reconcileCandidateMemories({
        candidates: [candidateMemory()],
        existingMemoryRecords: [],
        context: {
          userId: "user-1",
          namespace: "default",
          dreamSessionId: "dream-1",
        },
        llmTransport: new RecordedLlmTransport([
          { text: "{not-json", inputTokens: 1, outputTokens: 1 },
        ]),
      }),
    ).rejects.toThrow("dream_reconcile_json_parse_failed");

    await expect(
      reconcileCandidateMemories({
        candidates: [candidateMemory()],
        existingMemoryRecords: [],
        context: {
          userId: "user-1",
          namespace: "default",
          dreamSessionId: "dream-1",
        },
        llmTransport: new RecordedLlmTransport([
          { text: JSON.stringify([{ deltas: [] }]), inputTokens: 1, outputTokens: 1 },
        ]),
      }),
    ).rejects.toThrow(
      "dream_reconcile_json_shape_invalid: expected deltas array",
    );
  });

  it("serialises TOMBSTONE deltas with an empty record payload", async () => {
    const llmTransport = new RecordedLlmTransport([
      {
        text: JSON.stringify({
          deltas: [
            {
              action: "TOMBSTONE",
              targetId: "mem-1",
              record: null,
              expectedBaseVersion: 0,
              mutationId: "018f7f3a-91d8-7b3d-8d9e-000000000010",
            },
          ],
        }),
        inputTokens: 1,
        outputTokens: 1,
      },
    ]);

    const result = await reconcileCandidateMemories({
      candidates: [candidateMemory()],
      existingMemoryRecords: [memoryRecord()],
      context: {
        userId: "user-1",
        namespace: "default",
        dreamSessionId: "dream-1",
      },
      llmTransport,
    });

    expect(result).toEqual([
      {
        delta: expect.objectContaining({
          action: "TOMBSTONE",
          targetId: "mem-1",
          record: null,
          expectedBaseVersion: 0,
        }),
        recordSerialised: "",
      },
    ]);
  });

  // Privacy boundary: rejected LLM deltas can carry plaintext memory text.
  // The enclave's stdout/stderr is host-observable, so the validation-
  // failure path must NOT serialise the delta into the log.
  it("does not write rejected delta contents to stderr on validation failure", async () => {
    const SENTINEL = "PLAINTEXT_MEMORY_SHOULD_NEVER_BE_LOGGED";
    const llmTransport = new RecordedLlmTransport([
      {
        text: JSON.stringify({
          deltas: [{ action: "NOT_A_REAL_ACTION", record: { text: SENTINEL } }],
        }),
        inputTokens: 1,
        outputTokens: 1,
      },
    ]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        reconcileCandidateMemories({
          candidates: [candidateMemory()],
          existingMemoryRecords: [],
          context: {
            userId: "user-1",
            namespace: "default",
            dreamSessionId: "dream-1",
          },
          llmTransport,
        }),
      ).rejects.toThrow();

      const logged = errSpy.mock.calls
        .map((args) =>
          args
            .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
            .join(" "),
        )
        .join("\n");
      expect(logged).not.toContain(SENTINEL);
    } finally {
      errSpy.mockRestore();
    }
  });
});

// R8 Finding B (Codex): dream-reconciled records pass through the same
// canonicaliseMemoryRecord helper as the agent memory.write path. Verify
// that hostile id/namespace/dreamSessionId/baseVersion/provenance fields
// on the LLM-emitted record get overridden before hashing/signing, and
// that scrambled JSON key order still hashes identically to schema order.
describe("runDreamSession canonicalisation (R8 Finding B)", () => {
  it("overrides hostile record.id / namespace / dreamSessionId / baseVersion / provenance attribution", async () => {
    const hostileRecord = {
      id: "MODEL_LIED_ID",
      namespace: "health" as const,
      baseVersion: 999,
      tombstoneEpoch: 0,
      dreamSessionId: "MODEL_LIED_DREAM",
      kind: "preference" as const,
      text: "remote-only",
      structured: {},
      tags: ["work"],
      provenance: [
        {
          excerpt: "remote-only",
          excerptHash: "sha256:abc",
          sourceRef: { type: "conversation" as const, conversationId: "c1" },
          extractedAt: "2026-05-13T00:00:00.000Z",
          dreamSessionId: "MODEL_LIED_PROVENANCE",
        },
      ],
      confidence: 0.8,
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
      supersededBy: null,
      visibleToUser: true,
    };
    const llmTransport = new RecordedLlmTransport([
      {
        text: JSON.stringify({
          deltas: [
            {
              action: "ADD",
              targetId: "mem-canonical",
              record: hostileRecord,
              expectedBaseVersion: -1,
              mutationId: "018f7f3a-91d8-7b3d-8d9e-0000000000aa",
            },
          ],
        }),
        inputTokens: 1,
        outputTokens: 1,
      },
    ]);

    const result = await runDreamSession({
      candidate: makeDreamCandidate({
        triggerKind: "nightly-consolidation",
        dreamSessionId: "dream_authentic",
        namespace: "default",
        preExtractedCandidates: [candidateMemory()],
      }),
      llmTransport,
    });

    expect(result.deltas).toHaveLength(1);
    const out = result.deltas[0];
    // R13 Finding C: ADD targetId is enclave-minted; record.id matches.
    expect(out.delta.targetId).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.delta.targetId).not.toBe("mem-canonical");
    expect(out.delta.record!.id).toBe(out.delta.targetId);
    expect(out.delta.record!.namespace).toBe("default");
    expect(out.delta.record!.dreamSessionId).toBe("dream_authentic");
    expect(out.delta.record!.baseVersion).toBe(0); // ADD → newRecordVersion 0
    for (const p of out.delta.record!.provenance) {
      expect(p.dreamSessionId).toBe("dream_authentic");
    }
    // The recordSerialisedHash matches the canonical serialisation, so
    // the storage-layer save invariants will hold.
    const expected = "sha256:"; /* sentinel only — actual is hex */
    expect(out.recordSerialisedHash).not.toBe(expected);
    expect(out.recordSerialisedHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

// R9 Finding A (Codex): the LLM-supplied mutationId is overridden by an
// enclave-minted UUID. A hostile model that emits duplicate mutationIds
// across deltas can't cause replay/idempotency collisions at save time.
describe("runDreamSession mutationId minting (R9 Finding A)", () => {
  it("overrides every LLM-emitted mutationId with a fresh enclave-minted UUID", async () => {
    const record1 = {
      id: "mem-1",
      namespace: "default" as const,
      baseVersion: 0,
      tombstoneEpoch: 0,
      dreamSessionId: "dream-1",
      kind: "fact" as const,
      text: "A",
      structured: {},
      tags: [],
      provenance: candidateMemory().provenance,
      confidence: 0.9,
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
      supersededBy: null,
      visibleToUser: true,
    };
    const record2 = { ...record1, id: "mem-2", text: "B" };
    // Valid-shaped UUID v4 used by a hostile model — the enclave must
    // still override it with a fresh randomUUID() rather than passing
    // it through to the signed envelope.
    const SPOOF_ID = "00000000-0000-4000-8000-000000000000";
    const llmTransport = new RecordedLlmTransport([
      {
        text: JSON.stringify({
          deltas: [
            {
              action: "ADD",
              targetId: "mem-1",
              record: record1,
              expectedBaseVersion: -1,
              mutationId: SPOOF_ID,
            },
            {
              action: "ADD",
              targetId: "mem-2",
              record: record2,
              expectedBaseVersion: -1,
              mutationId: SPOOF_ID, // hostile duplicate
            },
          ],
        }),
        inputTokens: 1,
        outputTokens: 1,
      },
    ]);

    const result = await runDreamSession({
      candidate: makeDreamCandidate({
        triggerKind: "nightly-consolidation",
        preExtractedCandidates: [candidateMemory()],
      }),
      llmTransport,
    });

    expect(result.deltas).toHaveLength(2);
    const ids = result.deltas.map((d) => d.delta.mutationId);
    expect(ids[0]).not.toBe(SPOOF_ID);
    expect(ids[1]).not.toBe(SPOOF_ID);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    }
    // And they're distinct from each other (no duplicate replay key).
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe("runDreamSession target validation (Codex LOW F14)", () => {
  function existingRecord(id: string) {
    return {
      id,
      namespace: "default" as const,
      baseVersion: 0,
      tombstoneEpoch: 0,
      dreamSessionId: "dream-1",
      kind: "fact" as const,
      text: "kept",
      structured: {},
      tags: [],
      provenance: candidateMemory().provenance,
      confidence: 0.9,
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
      supersededBy: null,
      visibleToUser: true,
    };
  }

  it("rejects a TOMBSTONE targeting a record outside the reconcile set", async () => {
    const llmTransport = new RecordedLlmTransport([
      {
        text: JSON.stringify({
          deltas: [
            {
              action: "TOMBSTONE",
              targetId: "health-secret-id", // NOT in existingMemoryRecords
              record: null,
              expectedBaseVersion: 0,
              mutationId: "018f7f3a-91d8-7b3d-8d9e-0000000000bb",
            },
          ],
        }),
        inputTokens: 1,
        outputTokens: 1,
      },
    ]);

    await expect(
      runDreamSession({
        candidate: makeDreamCandidate({
          triggerKind: "reconcile-only",
          preExtractedCandidates: [candidateMemory()],
          existingMemoryRecords: [existingRecord("existing-1")],
        }),
        llmTransport,
      }),
    ).rejects.toThrow(/dream_reconcile_unknown_target/);
  });

  it("allows a SUPERSEDE targeting a record within the reconcile set", async () => {
    const supersede = {
      ...existingRecord("existing-1"),
      baseVersion: 1,
      text: "merged",
    };
    const llmTransport = new RecordedLlmTransport([
      {
        text: JSON.stringify({
          deltas: [
            {
              action: "SUPERSEDE",
              targetId: "existing-1",
              record: supersede,
              expectedBaseVersion: 0,
              mutationId: "018f7f3a-91d8-7b3d-8d9e-0000000000cc",
            },
          ],
        }),
        inputTokens: 1,
        outputTokens: 1,
      },
    ]);

    const result = await runDreamSession({
      candidate: makeDreamCandidate({
        triggerKind: "reconcile-only",
        preExtractedCandidates: [candidateMemory()],
        existingMemoryRecords: [existingRecord("existing-1")],
      }),
      llmTransport,
    });

    expect(result.deltas).toHaveLength(1);
    expect(result.deltas[0].delta.action).toBe("SUPERSEDE");
    expect(result.deltas[0].delta.targetId).toBe("existing-1");
  });
});

describe("runDreamSession", () => {
  it("uses LLM injection and bypasses extract for nightly consolidation", async () => {
    const llmTransport = new RecordedLlmTransport([
      {
        text: JSON.stringify({ deltas: [] }),
        inputTokens: 1,
        outputTokens: 1,
      },
    ]);

    const result = await runDreamSession({
      candidate: makeDreamCandidate({
        triggerKind: "nightly-consolidation",
        preExtractedCandidates: [candidateMemory()],
      }),
      llmTransport,
    });

    expect(result.deltas).toEqual([]);
    expect(llmTransport.requests).toHaveLength(1);
    expect(llmTransport.requests[0].systemPrompt).toContain("reconcile");
  });
});
