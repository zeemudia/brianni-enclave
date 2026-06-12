import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { CandidateMemory } from '../dream/types';
import {
  selectDreamExtractModel,
  selectDreamReconcileModel,
} from '../dream/model-routing';

function candidate(overrides: Partial<CandidateMemory> = {}): CandidateMemory {
  return {
    namespace: 'default',
    kind: 'preference',
    text: 'The user prefers concise launch notes.',
    structured: { style: 'concise' },
    tags: ['writing'],
    provenance: [
      {
        excerpt: 'Keep the launch notes concise.',
        excerptHash: 'sha256:abcdef12',
        sourceRef: { type: 'conversation', conversationId: 'conv_1' },
        extractedAt: '2026-06-06T12:00:00.000Z',
        dreamSessionId: 'dream_1',
      },
    ],
    confidence: 0.9,
    ...overrides,
  };
}

function registryModelIds(): Set<string> {
  const registry = JSON.parse(
    readFileSync(
      resolve(__dirname, '../providers/providers.json'),
      'utf8',
    ),
  ) as {
    providers: Array<{ models: Array<{ id: string }> }>;
  };
  return new Set(
    registry.providers.flatMap((provider) =>
      provider.models.map((model) => model.id),
    ),
  );
}

describe('Dream model routing', () => {
  it('uses the low-cost registry model for routine extraction', () => {
    expect(selectDreamExtractModel()).toBe('claude-haiku-4-5-20251001');
  });

  it('uses a non-frontier model for routine reconciliation', () => {
    expect(
      selectDreamReconcileModel({
        candidates: [candidate()],
        existingMemoryRecords: [],
      }),
    ).toBe('claude-sonnet-4-6');
  });

  it('escalates reconciliation to Opus only when candidate conflicts are likely', () => {
    expect(
      selectDreamReconcileModel({
        candidates: [
          candidate({ text: 'The user likes terse launch notes.' }),
          candidate({
            text: 'The user wants detailed launch notes.',
            structured: { style: 'detailed' },
          }),
        ],
        existingMemoryRecords: [
          {
            id: 'mem_1',
            namespace: 'default',
            baseVersion: 1,
            tombstoneEpoch: 0,
            dreamSessionId: 'dream_old',
            kind: 'preference',
            text: 'The user prefers concise launch notes.',
            structured: { style: 'concise' },
            tags: ['writing'],
            provenance: [],
            confidence: 0.8,
            createdAt: '2026-06-01T12:00:00.000Z',
            updatedAt: '2026-06-01T12:00:00.000Z',
            supersededBy: null,
            visibleToUser: true,
          },
        ],
      }),
    ).toBe('claude-opus-4-7');
  });

  it('escalates a single candidate when any existing record can conflict', () => {
    expect(
      selectDreamReconcileModel({
        candidates: [
          candidate({
            text: 'The user wants detailed launch notes.',
            structured: { style: 'detailed' },
            tags: ['style'],
          }),
        ],
        existingMemoryRecords: [
          {
            id: 'mem_1',
            namespace: 'default',
            baseVersion: 1,
            tombstoneEpoch: 0,
            dreamSessionId: 'dream_old',
            kind: 'preference',
            text: 'The user prefers concise launch notes.',
            structured: { style: 'concise' },
            tags: ['writing'],
            provenance: [],
            confidence: 0.8,
            createdAt: '2026-06-01T12:00:00.000Z',
            updatedAt: '2026-06-01T12:00:00.000Z',
            supersededBy: null,
            visibleToUser: true,
          },
        ],
      }),
    ).toBe('claude-opus-4-7');
  });

  it('keeps routine reconciliation on Sonnet when existing records cannot conflict', () => {
    expect(
      selectDreamReconcileModel({
        candidates: [candidate()],
        existingMemoryRecords: [
          {
            id: 'mem_health',
            namespace: 'health',
            baseVersion: 1,
            tombstoneEpoch: 0,
            dreamSessionId: 'dream_old',
            kind: 'goal',
            text: 'The user wants to run a 10K.',
            structured: { distanceKm: 10 },
            tags: ['fitness'],
            provenance: [],
            confidence: 0.8,
            createdAt: '2026-06-01T12:00:00.000Z',
            updatedAt: '2026-06-01T12:00:00.000Z',
            supersededBy: null,
            visibleToUser: true,
          },
        ],
      }),
    ).toBe('claude-sonnet-4-6');
  });

  it('only selects model ids that exist in the provider registry', () => {
    const ids = registryModelIds();

    expect(ids.has(selectDreamExtractModel())).toBe(true);
    expect(
      ids.has(
        selectDreamReconcileModel({
          candidates: [candidate()],
          existingMemoryRecords: [],
        }),
      ),
    ).toBe(true);
    expect(
      ids.has(
        selectDreamReconcileModel({
          candidates: [
            candidate({ structured: { style: 'concise' } }),
            candidate({ structured: { style: 'detailed' } }),
          ],
          existingMemoryRecords: [],
        }),
      ),
    ).toBe(true);
  });
});
