import { describe, expect, it, vi } from 'vitest';

import { extractCandidateMemories } from '../dream/extract';
import { RecordedLlmTransport } from '../dream/llm-transport';
import type { DreamCandidate } from '../dream/types';

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

describe('extractCandidateMemories', () => {
  it('skips conversations with fewer than 3 turns', async () => {
    const llmTransport = new RecordedLlmTransport([]);
    const result = await extractCandidateMemories({
      candidate: makeCandidate({
        conversationMessages: [
          { role: 'user', content: 'One' },
          { role: 'assistant', content: 'Two' },
        ],
      }),
      llmTransport,
    });

    expect(result).toEqual([]);
    expect(llmTransport.requests).toEqual([]);
  });

  it('does not count system messages toward the extraction turn threshold', async () => {
    const llmTransport = new RecordedLlmTransport([
      { text: 'should-not-be-used', inputTokens: 1, outputTokens: 1 },
    ]);
    const result = await extractCandidateMemories({
      candidate: makeCandidate({
        conversationMessages: [
          { role: 'system', content: 'System prompt' },
          { role: 'user', content: 'One user turn' },
          { role: 'assistant', content: 'One assistant turn' },
          { role: 'system', content: 'More system context' },
        ],
      }),
      llmTransport,
    });

    expect(result).toEqual([]);
    expect(llmTransport.requests).toEqual([]);
  });

  it('refuses to emit a candidate without provenance excerpt and excerptHash', async () => {
    const llmTransport = new RecordedLlmTransport([
      {
        text: JSON.stringify({
          candidates: [
            validCandidatePayload({
              provenance: [
                {
                  sourceRef: { type: 'conversation', conversationId: 'conv-1' },
                  extractedAt: '2026-05-11T00:00:00.000Z',
                  dreamSessionId: 'dream-1',
                },
              ],
            }),
          ],
        }),
        inputTokens: 1,
        outputTokens: 1,
      },
    ]);

    await expect(
      extractCandidateMemories({
        candidate: makeCandidate(),
        llmTransport,
      }),
    ).rejects.toThrow(/provenance/i);
  });

  it('aborts if the LLM emits invalid JSON', async () => {
    const llmTransport = new RecordedLlmTransport([
      { text: '{not-json', inputTokens: 1, outputTokens: 1 },
    ]);

    await expect(
      extractCandidateMemories({
        candidate: makeCandidate(),
        llmTransport,
      }),
    ).rejects.toThrow(/json/i);
  });

  it('rejects non-array extract payloads with a static shape error', async () => {
    const llmTransport = new RecordedLlmTransport([
      {
        text: JSON.stringify({ candidates: { not: 'an-array' } }),
        inputTokens: 1,
        outputTokens: 1,
      },
    ]);

    await expect(
      extractCandidateMemories({
        candidate: makeCandidate(),
        llmTransport,
      }),
    ).rejects.toThrow('dream_extract_json_shape_invalid: expected candidates array');
  });

  it('accepts a top-level array from the extract model', async () => {
    const llmTransport = new RecordedLlmTransport([
      {
        text: JSON.stringify([validCandidatePayload()]),
        inputTokens: 1,
        outputTokens: 1,
      },
    ]);

    const result = await extractCandidateMemories({
      candidate: makeCandidate(),
      llmTransport,
    });

    expect(result).toEqual([
      expect.objectContaining({
        namespace: 'default',
        kind: 'preference',
        text: 'User prefers focused mornings',
        confidence: 0.8,
      }),
    ]);
  });

  it('accepts markdown-fenced JSON from the extract model', async () => {
    const llmTransport = new RecordedLlmTransport([
      {
        text: `\`\`\`json\n${JSON.stringify({
          candidates: [validCandidatePayload()],
        })}\n\`\`\``,
        inputTokens: 1,
        outputTokens: 1,
      },
    ]);

    const result = await extractCandidateMemories({
      candidate: makeCandidate(),
      llmTransport,
    });

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('User prefers focused mornings');
  });

  it('bypasses extraction for nightly consolidation', async () => {
    const llmTransport = new RecordedLlmTransport([
      { text: 'should-not-be-used', inputTokens: 1, outputTokens: 1 },
    ]);

    const result = await extractCandidateMemories({
      candidate: makeCandidate({ triggerKind: 'nightly-consolidation' }),
      llmTransport,
    });

    expect(result).toEqual([]);
    expect(llmTransport.requests).toEqual([]);
  });

  it("bypasses extraction for 'reconcile-only' (Chunk J Wave 4)", async () => {
    const llmTransport = new RecordedLlmTransport([
      { text: 'should-not-be-used', inputTokens: 1, outputTokens: 1 },
    ]);

    const result = await extractCandidateMemories({
      candidate: makeCandidate({ triggerKind: 'reconcile-only' }),
      llmTransport,
    });

    expect(result).toEqual([]);
    expect(llmTransport.requests).toEqual([]);
  });

  it('masks conversation text before sending the zero-tool prompt', async () => {
    const mask = vi.fn(async (text: string, counter: number) => ({
      remasked: text.replace('Alice', '[NAME_1]'),
      new_tokens: {},
      next_counter: counter + 1,
    }));
    const llmTransport = new RecordedLlmTransport([
      {
        text: JSON.stringify({
          candidates: [validCandidatePayload()],
        }),
        inputTokens: 1,
        outputTokens: 1,
      },
    ]);

    const result = await extractCandidateMemories({
      candidate: makeCandidate({
        conversationMessages: [
          { role: 'user', content: 'Alice prefers focused mornings.' },
          { role: 'assistant', content: 'Noted.' },
          { role: 'user', content: 'Alice also avoids late meetings.' },
        ],
      }),
      llmTransport,
      masker: { mask },
    });

    expect(result).toHaveLength(1);
    expect(mask).toHaveBeenCalledTimes(3);
    expect(llmTransport.requests[0].model).toBe('claude-haiku-4-5-20251001');
    expect(llmTransport.requests[0].systemPrompt).toContain('zero tool access');
    expect(llmTransport.requests[0].systemPrompt).toContain('namespace: default');
    expect(llmTransport.requests[0].userMessage).toContain('[NAME_1]');
  });

  it.each([
    ['namespace invalid', { namespace: 'not-a-namespace' }, /namespace invalid/],
    ['namespace mismatch', { namespace: 'health' }, /namespace mismatch/],
    ['kind invalid', { kind: 'bad-kind' }, /kind invalid/],
    ['text required', { text: '   ' }, /text required/],
    ['structured required', { structured: null }, /structured object required/],
    ['tags required', { tags: 'work' }, /tags array required/],
    ['provenance required', { provenance: [] }, /provenance required/],
    ['confidence low', { confidence: -0.01 }, /confidence must be 0..1/],
    ['confidence high', { confidence: 1.01 }, /confidence must be 0..1/],
  ])('rejects extract candidate validation failure: %s', async (_name, patch, message) => {
    const llmTransport = new RecordedLlmTransport([
      {
        text: JSON.stringify({ candidates: [validCandidatePayload(patch)] }),
        inputTokens: 1,
        outputTokens: 1,
      },
    ]);

    await expect(
      extractCandidateMemories({
        candidate: makeCandidate(),
        llmTransport,
      }),
    ).rejects.toThrow(message);
  });

  it('keeps rejected model-derived candidate values out of thrown errors', async () => {
    const llmTransport = new RecordedLlmTransport([
      {
        text: JSON.stringify({
          candidates: [
            validCandidatePayload({
              text: 'PLAINTEXT_MEMORY_SHOULD_NOT_LEAK',
              provenance: [
                {
                  excerpt: 'PLAINTEXT_EXCERPT_SHOULD_NOT_LEAK',
                  excerptHash: 'bad',
                  sourceRef: { type: 'conversation', conversationId: 'conv-1' },
                  extractedAt: '2026-05-11T00:00:00.000Z',
                  dreamSessionId: 'dream-1',
                },
              ],
            }),
          ],
        }),
        inputTokens: 1,
        outputTokens: 1,
      },
    ]);

    await expect(
      extractCandidateMemories({
        candidate: makeCandidate(),
        llmTransport,
      }),
    ).rejects.toThrow('dream_extract_candidate_invalid:0: provenance 0 invalid');
    await expect(
      extractCandidateMemories({
        candidate: makeCandidate(),
        llmTransport: new RecordedLlmTransport([
          {
            text: JSON.stringify({
              candidates: [
                validCandidatePayload({
                  provenance: [
                    {
                      excerpt: 'PLAINTEXT_EXCERPT_SHOULD_NOT_LEAK',
                      excerptHash: 'bad',
                      sourceRef: { type: 'conversation', conversationId: 'conv-1' },
                      extractedAt: '2026-05-11T00:00:00.000Z',
                      dreamSessionId: 'dream-1',
                    },
                  ],
                }),
              ],
            }),
            inputTokens: 1,
            outputTokens: 1,
          },
        ]),
      }),
    ).rejects.not.toThrow(/PLAINTEXT/);
  });
});
