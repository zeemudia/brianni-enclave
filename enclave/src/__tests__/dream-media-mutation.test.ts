import { describe, expect, it } from 'vitest';
import type { MediaProvenanceRecord, MemoryRecord } from '@calypso/chat-types';

import { evaluateRenderCustody } from '../media/custody-gate';
import { canonicaliseDreamRecord } from '../dream/reconcile';

/*
 * Mutation-hardening supplement for the smaller media/dream guards:
 *   - custody-gate.ts: the "disabled" renderer trust level (a hard block that
 *     existing tests never exercised — a flip here would let ANY render through
 *     on a disabled backend).
 *   - reconcile.ts canonicaliseDreamRecord: the `if (!canonical) return null`
 *     fail-closed guard (a return-the-record mutant would hash/sign a
 *     schema-invalid record), plus the happy path that returns the
 *     canonicalised record + its serialisation.
 */

const publicRecord: MediaProvenanceRecord = {
  handleId: 'mh_public',
  kind: 'image',
  origin: 'public',
  providerVisible: false,
  sourceHandleIds: [],
  createdBy: 'import',
  createdAt: '2026-05-19T08:00:00.000Z',
  ttlSeconds: 900,
  byteSize: 4,
  sha256: 'a'.repeat(64),
  signature: 'sig',
};

const privateRecord: MediaProvenanceRecord = {
  ...publicRecord,
  handleId: 'mh_private',
  origin: 'generated_from_private',
  sha256: 'b'.repeat(64),
};

describe('render custody gate — disabled renderer is a hard block', () => {
  it('blocks public/generated inputs when the renderer is disabled', () => {
    expect(
      evaluateRenderCustody({
        records: [publicRecord],
        rendererTrustLevel: 'disabled',
      }),
    ).toEqual({
      allowed: false,
      reason: 'RENDERER_DISABLED',
      custody: 'public_or_generated',
    });
  });

  it('blocks private-tainted inputs when the renderer is disabled (disabled wins over the private branch)', () => {
    expect(
      evaluateRenderCustody({
        records: [privateRecord],
        rendererTrustLevel: 'disabled',
      }),
    ).toEqual({
      allowed: false,
      reason: 'RENDERER_DISABLED',
      custody: 'private',
    });
  });

  it('allows private-tainted inputs on an existing_tee renderer (only non_attested blocks them)', () => {
    expect(
      evaluateRenderCustody({
        records: [privateRecord],
        rendererTrustLevel: 'existing_tee',
      }),
    ).toEqual({ allowed: true, custody: 'private' });
  });
});

function dreamRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'mem-1',
    namespace: 'default',
    baseVersion: 0,
    tombstoneEpoch: 0,
    dreamSessionId: 'dream-1',
    kind: 'preference',
    text: 'User prefers focused mornings',
    structured: {},
    tags: ['work'],
    provenance: [
      {
        excerpt: 'I prefer focused mornings',
        excerptHash: 'sha256:abc',
        sourceRef: { type: 'conversation', conversationId: 'conv-1' },
        extractedAt: '2026-05-11T00:00:00.000Z',
        dreamSessionId: 'dream-1',
      },
    ],
    confidence: 0.8,
    createdAt: '2026-05-11T00:00:00.000Z',
    updatedAt: '2026-05-11T00:00:00.000Z',
    supersededBy: null,
    visibleToUser: true,
    ...overrides,
  };
}

const ctx = {
  blobId: 'blob-1',
  namespace: 'default' as const,
  dreamSessionId: 'dream-authentic',
  newRecordVersion: 0,
  nowIso: '2026-06-01T00:00:00.000Z',
};

describe('canonicaliseDreamRecord', () => {
  it('returns the canonicalised record and its serialisation on a valid record', () => {
    const result = canonicaliseDreamRecord(dreamRecord(), ctx);
    expect(result).not.toBeNull();
    expect(result!.record.id).toBe('blob-1'); // id is overridden to blobId
    expect(result!.record.dreamSessionId).toBe('dream-authentic');
    expect(result!.record.baseVersion).toBe(0);
    expect(result!.recordSerialised).toBe(JSON.stringify(result!.record));
    // serialisation is non-empty and parses back to the same object
    expect(JSON.parse(result!.recordSerialised)).toEqual(result!.record);
  });

  it('returns null (fail-closed) when the record cannot be made schema-valid', () => {
    // `kind` is a required field the canonicaliser does NOT default; an invalid
    // kind makes MemoryRecordSchema.safeParse fail ⇒ canonicaliseMemoryRecord
    // returns null ⇒ canonicaliseDreamRecord must propagate null, never sign it.
    const invalid = dreamRecord({ kind: 'not-a-kind' as never });
    expect(canonicaliseDreamRecord(invalid, ctx)).toBeNull();
  });
});
