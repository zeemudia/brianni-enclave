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

  it('refuses to emit a candidate without provenance excerpt and excerptHash', async () => {
    const llmTransport = new RecordedLlmTransport([
      {
        text: JSON.stringify({
          candidates: [
            {
              namespace: 'default',
              kind: 'preference',
              text: 'User prefers focused mornings',
              structured: {},
              tags: ['work'],
              provenance: [
                {
                  sourceRef: { type: 'conversation', conversationId: 'conv-1' },
                  extractedAt: '2026-05-11T00:00:00.000Z',
                  dreamSessionId: 'dream-1',
                },
              ],
              confidence: 0.8,
            },
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

  it('accepts markdown-fenced JSON from the extract model', async () => {
    const llmTransport = new RecordedLlmTransport([
      {
        text: `\`\`\`json\n${JSON.stringify({
          candidates: [
            {
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
            },
          ],
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
          candidates: [
            {
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
            },
          ],
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
});
