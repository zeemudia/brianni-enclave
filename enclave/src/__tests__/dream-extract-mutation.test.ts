import { describe, expect, it } from 'vitest';

import { extractCandidateMemories } from '../dream/extract';
import { RecordedLlmTransport } from '../dream/llm-transport';
import type { DreamCandidate } from '../dream/types';

/*
 * Mutation-hardening supplement for dream/extract.ts validation boundaries.
 * The existing dream-extract.test.ts proves the guards REJECT bad candidates;
 * this file pins the exact boundaries so off-by-one mutants (e.g. confidence
 * `< 0` → `<= 0`, `> 1` → `>= 1`) and the shape ternary die:
 *   - confidence 0 and 1 are ACCEPTED (boundary inclusive),
 *   - a `parsed.candidates` that is a non-array object is REJECTED with the
 *     static shape error (no model text leaks),
 *   - a top-level non-object/non-array parse (e.g. a bare number) is rejected.
 */

function makeCandidate(overrides: Partial<DreamCandidate> = {}): DreamCandidate {
  return {
    triggerKind: 'end-of-session',
    dreamSessionId: 'dream-1',
    userId: 'user-1',
    namespace: 'default',
    conversationMessages: [
      { role: 'user', content: 'I prefer focused mornings.' },
      { role: 'assistant', content: 'Got it.' },
      { role: 'user', content: 'Please avoid late meetings.' },
    ],
    existingMemoryRecords: [],
    ...overrides,
  };
}

function validCandidatePayload(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

async function extract(text: string) {
  return extractCandidateMemories({
    candidate: makeCandidate(),
    llmTransport: new RecordedLlmTransport([{ text, inputTokens: 1, outputTokens: 1 }]),
  });
}

describe('extract confidence bounds are inclusive at 0 and 1', () => {
  it('accepts a candidate with confidence exactly 0', async () => {
    const result = await extract(
      JSON.stringify({ candidates: [validCandidatePayload({ confidence: 0 })] }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe(0);
  });

  it('accepts a candidate with confidence exactly 1', async () => {
    const result = await extract(
      JSON.stringify({ candidates: [validCandidatePayload({ confidence: 1 })] }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe(1);
  });

  it('rejects a non-number confidence (the typeof guard, not just the range)', async () => {
    await expect(
      extract(JSON.stringify({ candidates: [validCandidatePayload({ confidence: '0.5' })] })),
    ).rejects.toThrow('dream_extract_candidate_invalid:0: confidence must be 0..1');
  });
});

describe('extract top-level shape handling', () => {
  it('rejects a parsed object whose candidates field is a non-array object', async () => {
    await expect(
      extract(JSON.stringify({ candidates: { nested: 'object' } })),
    ).rejects.toThrow('dream_extract_json_shape_invalid: expected candidates array');
  });

  it('rejects a bare non-object/non-array JSON value (e.g. a number)', async () => {
    await expect(extract('42')).rejects.toThrow(
      'dream_extract_json_shape_invalid: expected candidates array',
    );
  });

  it('rejects a non-object array element with the index-bearing static error', async () => {
    await expect(
      extract(JSON.stringify({ candidates: ['not-an-object'] })),
    ).rejects.toThrow('dream_extract_candidate_invalid:0: expected object');
  });

  it('reports the correct index for the SECOND candidate when it is invalid', async () => {
    await expect(
      extract(
        JSON.stringify({
          candidates: [validCandidatePayload(), validCandidatePayload({ text: '   ' })],
        }),
      ),
    ).rejects.toThrow('dream_extract_candidate_invalid:1: text required');
  });
});
