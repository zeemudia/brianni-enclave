import { describe, expect, it } from "vitest";
import {
  DreamDeltaSchema,
  MemoryMutationEnvelopeSchema,
  MemoryRecordSchema,
  type MemoryRecord,
} from "../memory";

const validRecord: MemoryRecord = {
  id: "mem-ghost-vector",
  namespace: "default",
  baseVersion: 0,
  tombstoneEpoch: 0,
  dreamSessionId: "dream-ghost-vector",
  kind: "fact",
  text: "Uses short answers for status updates.",
  structured: {},
  tags: ["status"],
  provenance: [
    {
      excerpt: "Short answers are best for status updates.",
      excerptHash: `sha256:${"a".repeat(64)}`,
      sourceRef: {
        type: "conversation",
        conversationId: "conversation-ghost-vector",
      },
      extractedAt: "2026-05-12T10:00:00.000Z",
      dreamSessionId: "dream-ghost-vector",
    },
  ],
  confidence: 0.91,
  createdAt: "2026-05-12T10:00:00.000Z",
  updatedAt: "2026-05-12T10:00:00.000Z",
  supersededBy: null,
  visibleToUser: true,
};

describe("ghost fail-closed layer 1: chat-types schemas", () => {
  it("rejects ghost before a MemoryRecord can be constructed", () => {
    const parsed = MemoryRecordSchema.safeParse({
      ...validRecord,
      namespace: "ghost",
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects ghost before a DreamDelta can carry it toward storage", () => {
    const parsed = DreamDeltaSchema.safeParse({
      action: "ADD",
      targetId: validRecord.id,
      record: { ...validRecord, namespace: "ghost" },
      expectedBaseVersion: -1,
      mutationId: "018f9b2a-7c4d-7000-8000-000000000024",
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects ghost before a mutation envelope can be accepted by the route schema", () => {
    const parsed = MemoryMutationEnvelopeSchema.safeParse({
      v: 1,
      userId: "user-ghost-vector",
      namespace: "ghost",
      blobId: validRecord.id,
      action: "ADD",
      expectedBaseVersion: -1,
      newRecordVersion: 0,
      kind: "fact",
      mutationId: "018f9b2a-7c4d-7000-8000-000000000025",
      dreamSessionId: "dream-ghost-vector",
      teeSessionId: "tee-ghost-vector",
      contentHash: "a".repeat(64),
      recordSerialisedHash: "b".repeat(64),
      provenanceConversationIds: ["conversation-ghost-vector"],
      issuedAt: "2026-05-12T10:00:00.000Z",
      expiresAt: "2026-05-12T10:01:00.000Z",
    });

    expect(parsed.success).toBe(false);
  });
});
