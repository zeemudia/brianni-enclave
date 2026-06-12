import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AnthropicLlmTransport,
  RecordedLlmTransport,
} from '../dream/llm-transport';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AnthropicLlmTransport', () => {
  it('adapts a complete request to the Anthropic Messages API', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: '{"candidates":[]}' }],
        usage: { input_tokens: 12, output_tokens: 7 },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const transport = new AnthropicLlmTransport({
      apiKey: 'sk-ant-test',
      baseUrl: 'https://api.anthropic.test',
    });

    const result = await transport.complete({
      model: 'claude-opus-4-7',
      systemPrompt: 'zero tools',
      userMessage: 'extract memories',
      maxOutputTokens: 1000,
      temperature: 0,
    });

    expect(result).toEqual({
      text: '{"candidates":[]}',
      inputTokens: 12,
      outputTokens: 7,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.test/v1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-api-key': 'sk-ant-test',
          'anthropic-version': '2023-06-01',
        }),
        body: JSON.stringify({
          model: 'claude-opus-4-7',
          system: 'zero tools',
          messages: [{ role: 'user', content: 'extract memories' }],
          max_tokens: 1000,
        }),
      }),
    );
  });
});

describe('AnthropicLlmTransport — provider error body privacy', () => {
  it('does not log the raw provider error body (which may echo request content)', async () => {
    const SENTINEL = 'PROVIDER_ECHOED_PLAINTEXT_PROMPT_CONTENT';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => `{"error":"${SENTINEL}"}`,
    });
    vi.stubGlobal('fetch', fetchMock);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const transport = new AnthropicLlmTransport({
      apiKey: 'sk-ant-test',
      baseUrl: 'https://api.anthropic.test',
    });

    try {
      await expect(
        transport.complete({
          model: 'claude-opus-4-7',
          systemPrompt: 'sys',
          userMessage: 'user',
          maxOutputTokens: 100,
          temperature: 0,
        }),
      ).rejects.toThrow();

      const logged = errSpy.mock.calls
        .map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
        .join('\n');
      expect(logged).not.toContain(SENTINEL);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('RecordedLlmTransport', () => {
  it('round-trips fixtures deterministically and records requests', async () => {
    const transport = new RecordedLlmTransport([
      {
        text: '{"ok":true}',
        inputTokens: 3,
        outputTokens: 2,
      },
    ]);

    const first = await transport.complete({
      model: 'fixture-model',
      systemPrompt: 'system',
      userMessage: 'user',
    });

    expect(first.text).toBe('{"ok":true}');
    expect(transport.requests).toEqual([
      {
        model: 'fixture-model',
        systemPrompt: 'system',
        userMessage: 'user',
      },
    ]);
    await expect(
      transport.complete({
        model: 'fixture-model',
        systemPrompt: 'system',
        userMessage: 'again',
      }),
    ).rejects.toThrow(/recorded llm fixture exhausted/i);
  });
});
