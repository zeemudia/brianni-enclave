import { describe, expect, it } from 'vitest';

import { RecordedLlmTransport } from '../dream/llm-transport';
import { reconcileCandidateMemories } from '../dream';
import type { CandidateMemory } from '../dream/types';

/*
 * Mutation-hardening supplement for dream/reconcile.ts parseReconcileDeltas.
 * The existing dream-reconcile.test.ts proves the parse/shape/validation
 * failures throw; this file pins the EXACT static error messages (so the
 * `dream_reconcile_delta_invalid:${index}` index-bearing string and the
 * shape error can't be emptied by a string-literal mutant) and pins that a
 * non-object top-level parse is rejected (the `&& Array.isArray(...)` guard).
 */

function candidateMemory(): CandidateMemory {
  return {
    namespace: 'default',
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
  };
}

async function reconcile(text: string) {
  return reconcileCandidateMemories({
    candidates: [candidateMemory()],
    existingMemoryRecords: [],
    context: { userId: 'user-1', namespace: 'default', dreamSessionId: 'dream-1' },
    llmTransport: new RecordedLlmTransport([{ text, inputTokens: 1, outputTokens: 1 }]),
  });
}

describe('parseReconcileDeltas static error messages', () => {
  it('rejects a top-level non-object (bare array) with the static shape error', async () => {
    // `[1,2]` parses fine but is not `{deltas:[...]}` ⇒ the
    // `&& Array.isArray(parsed.deltas)` guard must reject it.
    await expect(reconcile(JSON.stringify([1, 2]))).rejects.toThrow(
      'dream_reconcile_json_shape_invalid: expected deltas array',
    );
  });

  it('rejects a bare number top-level value with the static shape error', async () => {
    await expect(reconcile('7')).rejects.toThrow(
      'dream_reconcile_json_shape_invalid: expected deltas array',
    );
  });

  it('throws the index-bearing static error for an invalid delta at index 0', async () => {
    await expect(
      reconcile(JSON.stringify({ deltas: [{ action: 'NOT_A_REAL_ACTION' }] })),
    ).rejects.toThrow('dream_reconcile_delta_invalid:0');
  });

  it('reports the correct NON-zero index for an invalid delta at index 1', async () => {
    const validAdd = {
      action: 'ADD',
      targetId: 'mem-1',
      record: {
        id: 'mem-1',
        namespace: 'default',
        baseVersion: 0,
        tombstoneEpoch: 0,
        dreamSessionId: 'dream-1',
        kind: 'preference',
        text: 'A',
        structured: {},
        tags: [],
        provenance: candidateMemory().provenance,
        confidence: 0.9,
        createdAt: '2026-05-11T00:00:00.000Z',
        updatedAt: '2026-05-11T00:00:00.000Z',
        supersededBy: null,
        visibleToUser: true,
      },
      expectedBaseVersion: -1,
      mutationId: '018f7f3a-91d8-7b3d-8d9e-000000000001',
    };
    await expect(
      reconcile(JSON.stringify({ deltas: [validAdd, { action: 'NOPE' }] })),
    ).rejects.toThrow('dream_reconcile_delta_invalid:1');
  });
});
