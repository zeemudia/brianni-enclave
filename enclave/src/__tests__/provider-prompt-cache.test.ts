import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AnthropicProcessor } from '../providers/adapters/anthropic-v1';
import { OpenAIProcessor } from '../providers/adapters/openai-v1';
import {
  buildAnthropicPromptCacheRequest,
  buildGeminiPrivatePromptCacheOptions,
  buildOpenAIPrivatePromptCacheOptions,
  planProviderPromptCaching,
} from '../providers/prompt-cache';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function drainWithReturn<T>(
  gen: AsyncGenerator<unknown, T>,
): Promise<T> {
  while (true) {
    const next = await gen.next();
    if (next.done) return next.value;
  }
}

function responseFromSse(lines: unknown[]): Response {
  return new Response(
    lines
      .map((line) => `data: ${typeof line === 'string' ? line : JSON.stringify(line)}\n\n`)
      .join(''),
  );
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>, index = 0): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[index] as [
    unknown,
    { body?: string } | undefined,
  ];
  return JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
}

describe('privacy-preserving provider prompt caching', () => {
  it('uses the correct Anthropic per-model cache floors', () => {
    expect(
      planProviderPromptCaching({
        providerId: 'anthropic',
        model: 'claude-sonnet-4-6',
        estimatedInputTokens: 2_047,
      }),
    ).toMatchObject({
      providerId: 'anthropic',
      mode: 'anthropic_ephemeral',
      eligibleForProviderWrite: false,
      minCacheableInputTokens: 2_048,
      reason: 'prefix_below_threshold',
    });

    expect(
      planProviderPromptCaching({
        providerId: 'anthropic',
        model: 'claude-sonnet-4-6',
        estimatedInputTokens: 2_048,
      }),
    ).toMatchObject({
      eligibleForProviderWrite: true,
      minCacheableInputTokens: 2_048,
    });

    expect(
      planProviderPromptCaching({
        providerId: 'anthropic',
        model: 'claude-opus-4-7',
        estimatedInputTokens: 4_095,
      }),
    ).toMatchObject({
      eligibleForProviderWrite: false,
      minCacheableInputTokens: 4_096,
    });
  });

  it('converts eligible Anthropic system prompts to ephemeral cache-control blocks only', () => {
    const request = buildAnthropicPromptCacheRequest({
      model: 'claude-opus-4-7',
      system: 'stable Calypso system prompt\n'.repeat(1_000),
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(request.plan).toMatchObject({
      mode: 'anthropic_ephemeral',
      eligibleForProviderWrite: true,
    });
    expect(request.system).toEqual([
      expect.objectContaining({
        type: 'text',
        cache_control: { type: 'ephemeral' },
      }),
    ]);
    expect(JSON.stringify(request.system)).not.toContain('ttl');
    expect(JSON.stringify(request.system)).not.toContain('cache_key');
  });

  it('adds intermediate Anthropic breakpoints within the 20-block lookback window and caps them at four', () => {
    const request = buildAnthropicPromptCacheRequest({
      model: 'claude-opus-4-7',
      estimatedInputTokens: 8_000,
      messages: Array.from({ length: 50 }, (_, index) => ({
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `message ${index}`,
      })),
    });

    const breakpointIndexes = request.messages.flatMap((message, index) => {
      const content = message.content;
      if (!Array.isArray(content)) return [];
      return content.some((part) => Boolean(part.cache_control)) ? [index] : [];
    });

    expect(breakpointIndexes).toEqual([14, 29, 44, 49]);
    expect(request.cacheBreakpoints).toEqual([
      { location: 'message', index: 14 },
      { location: 'message', index: 29 },
      { location: 'message', index: 44 },
      { location: 'message', index: 49 },
    ]);
  });

  it('skips Anthropic message breakpoints on non-string content instead of replacing it with a text block', () => {
    const structuredContent = [{ type: 'image', source: { type: 'base64' } }];
    const request = buildAnthropicPromptCacheRequest({
      model: 'claude-opus-4-7',
      estimatedInputTokens: 8_000,
      messages: Array.from({ length: 21 }, (_, index) => ({
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content:
          index === 14
            ? (structuredContent as unknown as string)
            : `string message ${index}`,
      })),
    });

    expect(request.messages[14].content).toBe(structuredContent);
    expect(request.cacheBreakpoints).not.toContainEqual({
      location: 'message',
      index: 14,
    });
  });

  it('does not opt private OpenAI prompts into extended-retention cache state', () => {
    expect(
      buildOpenAIPrivatePromptCacheOptions({ model: 'gpt-5.5' }),
    ).toEqual({
      requestOptions: {},
      plan: expect.objectContaining({
        mode: 'openai_automatic_only',
        reason: 'extended_retention_requires_privacy_review',
      }),
    });
  });

  it('keeps Gemini explicit cachedContents off private chat and Dream paths', () => {
    expect(
      buildGeminiPrivatePromptCacheOptions({ model: 'gemini-3.1-pro-preview' }),
    ).toEqual({
      requestOptions: {},
      plan: expect.objectContaining({
        mode: 'gemini_implicit_only',
        reason: 'explicit_cache_disabled_for_private_content',
      }),
    });
  });

  it('covers every registry model id with a prompt-cache policy entry or safe fallback', () => {
    const registry = JSON.parse(
      readFileSync(
        resolve(__dirname, '../providers/providers.json'),
        'utf8',
      ),
    ) as {
      providers: Array<{
        id: string;
        models: Array<{ id: string }>;
      }>;
    };

    for (const provider of registry.providers) {
      for (const model of provider.models) {
        expect(
          planProviderPromptCaching({
            providerId: provider.id,
            model: model.id,
            estimatedInputTokens: 10_000,
          }),
          `${provider.id}/${model.id}`,
        ).toMatchObject({
          providerId: provider.id,
          model: model.id,
        });
      }
    }
  });
});

describe('provider adapters prompt-cache integration', () => {
  it('Anthropic sends eligible system prompts with ephemeral cache_control and returns cache usage counters', async () => {
    const fetchMock = vi.fn(
      async () =>
        responseFromSse([
          {
            type: 'message_start',
            message: {
              usage: {
                input_tokens: 120,
                cache_creation_input_tokens: 4_096,
                cache_read_input_tokens: 512,
              },
            },
          },
          {
            type: 'content_block_delta',
            message_id: 'msg_1',
            delta: { text: 'ok' },
          },
          {
            type: 'message_delta',
            usage: { output_tokens: 12 },
          },
          { type: 'message_stop' },
        ]),
    );
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new AnthropicProcessor(
      'https://api.anthropic.com',
      'sk-ant-test',
    );
    const usage = await drainWithReturn(
      processor.streamChat(
        [
          {
            role: 'system',
            content: 'stable Calypso prefix\n'.repeat(1_000),
          },
          { role: 'user', content: 'Hello' },
        ],
        { model: 'claude-opus-4-7' },
      ),
    );

    const body = requestBody(fetchMock);
    expect(body.system).toEqual([
      expect.objectContaining({
        type: 'text',
        cache_control: { type: 'ephemeral' },
      }),
    ]);
    expect(JSON.stringify(body)).not.toContain('ttl');
    expect(usage).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      usage: {
        input_tokens: 120,
        cache_creation_input_tokens: 4_096,
        cache_read_input_tokens: 512,
        output_tokens: 12,
      },
    });
  });

  it('OpenAI requests rely on automatic prompt caching without sending cache keys or retention flags for private prompts', async () => {
    const fetchMock = vi.fn(
      async () =>
        responseFromSse([
          {
            id: 'chatcmpl_1',
            choices: [{ delta: { content: 'ok' }, finish_reason: null }],
          },
          {
            id: 'chatcmpl_1',
            choices: [],
            usage: {
              prompt_tokens: 1_500,
              completion_tokens: 12,
              prompt_tokens_details: { cached_tokens: 512 },
            },
          },
          '[DONE]',
        ]),
    );
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new OpenAIProcessor('https://api.openai.com/v1', 'sk-test');
    const usage = await drainWithReturn(
      processor.streamChat(
        [
          { role: 'system', content: 'private Calypso context' },
          { role: 'user', content: 'Hello' },
        ],
        { model: 'gpt-5.5' },
      ),
    );

    const body = requestBody(fetchMock);
    expect(body).not.toHaveProperty('prompt_cache_key');
    expect(body).not.toHaveProperty('prompt_cache_retention');
    expect(body).not.toHaveProperty('cache_control');
    expect(usage).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.5',
      usage: {
        prompt_tokens: 1_500,
        completion_tokens: 12,
        prompt_tokens_details: { cached_tokens: 512 },
      },
    });
  });
});
