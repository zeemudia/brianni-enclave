import { describe, expect, it } from 'vitest';

import {
  DreamDeltaSchema,
  MEMORY_NAMESPACES,
  MemoryKindSchema,
  MemoryMutationEnvelopeSchema,
  MemoryNamespaceSchema,
  MemoryRecordSchema,
  MemorySourceRefSchema,
  SHA256_OF_EMPTY,
  TOMBSTONE_RECORD_SERIALISED_HASH,
  type MemoryNamespace,
} from '../memory';

const validRecord = {
  id: 'mem-1',
  namespace: 'default',
  baseVersion: 1,
  tombstoneEpoch: 0,
  dreamSessionId: 'ds-1',
  kind: 'fact',
  text: 'User prefers async work',
  structured: {},
  tags: [],
  provenance: [
    {
      excerpt: 'I prefer async',
      excerptHash: 'sha256:abc',
      sourceRef: { type: 'conversation', conversationId: 'c-1' },
      extractedAt: '2026-05-11T00:00:00.000Z',
      dreamSessionId: 'ds-1',
    },
  ],
  confidence: 0.9,
  createdAt: '2026-05-11T00:00:00.000Z',
  updatedAt: '2026-05-11T00:00:00.000Z',
  supersededBy: null,
  visibleToUser: true,
};

describe('MEMORY_NAMESPACES runtime const tuple (Chunk I depends on this)', () => {
  it('exports exactly 5 namespaces in the locked order', () => {
    expect(MEMORY_NAMESPACES.length).toBe(5);
    expect([...MEMORY_NAMESPACES]).toEqual([
      'default',
      'work',
      'money',
      'health',
      'relationships',
    ]);
  });

  it('has runtime values that match the type union for z.enum usage', () => {
    for (const ns of MEMORY_NAMESPACES) {
      expect(MemoryNamespaceSchema.safeParse(ns).success).toBe(true);
    }
  });
});

describe('MemoryNamespaceSchema', () => {
  it('accepts exactly the 5 documented namespaces', () => {
    const valid: MemoryNamespace[] = ['default', 'work', 'money', 'health', 'relationships'];

    for (const ns of valid) {
      expect(MemoryNamespaceSchema.safeParse(ns).success).toBe(true);
    }
  });

  it('rejects "ghost" because ghost mode is not a namespace', () => {
    const r = MemoryNamespaceSchema.safeParse('ghost');

    expect(r.success).toBe(false);
  });

  it('rejects empty string, uppercase, whitespace, and arbitrary strings', () => {
    for (const bad of ['', ' default', 'DEFAULT', 'Work', 'finance', 'love']) {
      expect(MemoryNamespaceSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('MemoryKindSchema', () => {
  it('accepts the 5 documented kinds', () => {
    for (const k of ['fact', 'preference', 'episode', 'lesson', 'goal']) {
      expect(MemoryKindSchema.safeParse(k).success).toBe(true);
    }
  });

  it('rejects unknown kinds', () => {
    expect(MemoryKindSchema.safeParse('memory').success).toBe(false);
  });
});

describe('MemoryRecordSchema', () => {
  it('requires every documented field', () => {
    expect(MemoryRecordSchema.safeParse(validRecord).success).toBe(true);
  });

  it('rejects ghost namespace at the record level too', () => {
    expect(
      MemoryRecordSchema.safeParse({
        ...validRecord,
        namespace: 'ghost',
      }).success,
    ).toBe(false);
  });

  it('rejects records with empty provenance because every saved detail cites a source', () => {
    expect(
      MemoryRecordSchema.safeParse({
        ...validRecord,
        provenance: [],
      }).success,
    ).toBe(false);
  });

  it('accepts conversation, file, and web provenance source references', () => {
    expect(
      MemorySourceRefSchema.parse({
        type: 'conversation',
        conversationId: 'conv-1',
        messageIndex: 0,
      }),
    ).toEqual({
      type: 'conversation',
      conversationId: 'conv-1',
      messageIndex: 0,
    });
    expect(
      MemorySourceRefSchema.parse({
        type: 'file',
        fileHandleAlias: 'linked-notes',
        fileContentHash: `sha256:${'a'.repeat(64)}`,
      }),
    ).toMatchObject({ type: 'file' });
    expect(
      MemorySourceRefSchema.parse({
        type: 'web',
        urlHash: `sha256:${'b'.repeat(64)}`,
        host: 'example.com',
      }),
    ).toMatchObject({ type: 'web' });
  });

  it('rejects malformed source references and out-of-range record fields', () => {
    expect(
      MemorySourceRefSchema.safeParse({
        type: 'conversation',
        conversationId: '',
        messageIndex: -1,
      }).success,
    ).toBe(false);
    expect(
      MemorySourceRefSchema.safeParse({
        type: 'file',
        fileHandleAlias: 'linked-notes',
        fileContentHash: 'sha256:not-hex',
      }).success,
    ).toBe(false);
    expect(
      MemoryRecordSchema.safeParse({
        ...validRecord,
        confidence: 1.01,
      }).success,
    ).toBe(false);
    expect(
      MemoryRecordSchema.safeParse({
        ...validRecord,
        text: '',
      }).success,
    ).toBe(false);
    expect(
      MemoryRecordSchema.safeParse({
        ...validRecord,
        createdAt: 'not-a-date',
      }).success,
    ).toBe(false);
    expect(
      MemoryRecordSchema.safeParse({
        ...validRecord,
        tags: Array.from({ length: 33 }, (_, i) => `tag-${i}`),
      }).success,
    ).toBe(false);
  });
});

describe('DreamDeltaSchema + MemoryMutationEnvelopeSchema action invariants', () => {
  it('accepts ADD, UPDATE, SUPERSEDE, and TOMBSTONE actions with matching record shape', () => {
    for (const action of ['ADD', 'UPDATE', 'SUPERSEDE', 'TOMBSTONE']) {
      const r = DreamDeltaSchema.safeParse({
        action,
        targetId: 'mem-1',
        record: action === 'TOMBSTONE' ? null : validRecord,
        expectedBaseVersion: action === 'ADD' ? -1 : 1,
        mutationId: '018f9b2a-7c4d-7000-8000-000000000001',
      });

      expect(r.success).toBe(true);
    }
  });

  it('enforces tombstone and non-tombstone envelope hash invariants', () => {
    const baseEnv = {
      v: 1 as const,
      userId: 'u',
      namespace: 'default' as const,
      blobId: 'b',
      expectedBaseVersion: -1,
      newRecordVersion: 0,
      kind: 'fact' as const,
      mutationId: '018f9b2a-7c4d-7000-8000-000000000001',
      dreamSessionId: 'ds',
      teeSessionId: 'tee',
      provenanceConversationIds: [],
      issuedAt: '2026-05-11T00:00:00.000Z',
      expiresAt: '2026-05-11T00:01:00.000Z',
    };

    expect(
      MemoryMutationEnvelopeSchema.safeParse({
        ...baseEnv,
        action: 'ADD',
        contentHash: SHA256_OF_EMPTY,
        recordSerialisedHash: 'c'.repeat(64),
      }).success,
    ).toBe(false);

    expect(
      MemoryMutationEnvelopeSchema.safeParse({
        ...baseEnv,
        action: 'TOMBSTONE',
        contentHash: 'a'.repeat(64),
        recordSerialisedHash: TOMBSTONE_RECORD_SERIALISED_HASH,
      }).success,
    ).toBe(false);

    expect(
      MemoryMutationEnvelopeSchema.safeParse({
        ...baseEnv,
        action: 'TOMBSTONE',
        contentHash: SHA256_OF_EMPTY,
        recordSerialisedHash: 'c'.repeat(64),
      }).success,
    ).toBe(false);

    expect(
      MemoryMutationEnvelopeSchema.safeParse({
        ...baseEnv,
        action: 'TOMBSTONE',
        contentHash: SHA256_OF_EMPTY,
        recordSerialisedHash: TOMBSTONE_RECORD_SERIALISED_HASH,
      }).success,
    ).toBe(true);
  });

  it('rejects ADD with expectedBaseVersion other than -1', () => {
    const r = DreamDeltaSchema.safeParse({
      action: 'ADD',
      targetId: 'mem-1',
      record: validRecord,
      expectedBaseVersion: 0,
      mutationId: '018f9b2a-7c4d-7000-8000-000000000001',
    });

    expect(r.success).toBe(false);
  });

  it('rejects non-ADD deltas with expectedBaseVersion=-1 and mismatched record nullability', () => {
    expect(
      DreamDeltaSchema.safeParse({
        action: 'UPDATE',
        targetId: 'mem-1',
        record: validRecord,
        expectedBaseVersion: -1,
        mutationId: '018f9b2a-7c4d-7000-8000-000000000001',
      }).success,
    ).toBe(false);
    expect(
      DreamDeltaSchema.safeParse({
        action: 'UPDATE',
        targetId: 'mem-1',
        record: null,
        expectedBaseVersion: 1,
        mutationId: '018f9b2a-7c4d-7000-8000-000000000001',
      }).success,
    ).toBe(false);
    expect(
      DreamDeltaSchema.safeParse({
        action: 'TOMBSTONE',
        targetId: 'mem-1',
        record: validRecord,
        expectedBaseVersion: 1,
        mutationId: '018f9b2a-7c4d-7000-8000-000000000001',
      }).success,
    ).toBe(false);
  });

  it('rejects non-tombstone envelopes that use empty-content or tombstone sentinels', () => {
    const baseEnv = {
      v: 1 as const,
      userId: 'u',
      namespace: 'default' as const,
      blobId: 'b',
      action: 'SUPERSEDE' as const,
      expectedBaseVersion: 1,
      newRecordVersion: 2,
      kind: 'lesson' as const,
      mutationId: '018f9b2a-7c4d-7000-8000-000000000001',
      dreamSessionId: 'ds',
      teeSessionId: 'tee',
      provenanceConversationIds: ['conv-1'],
      issuedAt: '2026-05-11T00:00:00.000Z',
      expiresAt: '2026-05-11T00:01:00.000Z',
    };

    expect(
      MemoryMutationEnvelopeSchema.safeParse({
        ...baseEnv,
        contentHash: 'a'.repeat(64),
        recordSerialisedHash: TOMBSTONE_RECORD_SERIALISED_HASH,
      }).success,
    ).toBe(false);
    expect(
      MemoryMutationEnvelopeSchema.safeParse({
        ...baseEnv,
        contentHash: 'a'.repeat(64),
        recordSerialisedHash: 'c'.repeat(64),
      }).success,
    ).toBe(true);
  });
});
