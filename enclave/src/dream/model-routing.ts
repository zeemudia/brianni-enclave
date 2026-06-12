import type { MemoryRecord } from '@calypso/chat-types';

import type { CandidateMemory } from './types';

export const DREAM_EXTRACT_MODEL_ID = 'claude-haiku-4-5-20251001';
export const DREAM_RECONCILE_MODEL_ID = 'claude-sonnet-4-6';
export const DREAM_RECONCILE_CONFLICT_MODEL_ID = 'claude-opus-4-7';

export function selectDreamExtractModel(): string {
  return DREAM_EXTRACT_MODEL_ID;
}

export function selectDreamReconcileModel(input: {
  candidates: readonly CandidateMemory[];
  existingMemoryRecords: readonly MemoryRecord[];
}): string {
  return hasLikelyReconcileConflict(input)
    ? DREAM_RECONCILE_CONFLICT_MODEL_ID
    : DREAM_RECONCILE_MODEL_ID;
}

function hasLikelyReconcileConflict(input: {
  candidates: readonly CandidateMemory[];
  existingMemoryRecords: readonly MemoryRecord[];
}): boolean {
  if (hasExistingRecordOverlap(input)) return true;
  if (input.candidates.length < 2) return false;
  if (hasCandidateStructuredConflict(input.candidates)) return true;
  return false;
}

function hasExistingRecordOverlap(input: {
  candidates: readonly CandidateMemory[];
  existingMemoryRecords: readonly MemoryRecord[];
}): boolean {
  return input.candidates.some((candidate) =>
    input.existingMemoryRecords.some(
      (record) =>
        record.namespace === candidate.namespace && record.kind === candidate.kind,
    ),
  );
}

function hasCandidateStructuredConflict(
  candidates: readonly CandidateMemory[],
): boolean {
  const byTopic = new Map<string, string>();
  for (const candidate of candidates) {
    const key = [
      candidate.namespace,
      candidate.kind,
      [...candidate.tags].sort().join(','),
    ].join(':');
    const structured = stableStringify(candidate.structured);
    const previous = byTopic.get(key);
    if (previous !== undefined && previous !== structured) return true;
    byTopic.set(key, structured);
  }
  return false;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
