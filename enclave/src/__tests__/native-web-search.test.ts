import { afterEach, describe, expect, it, vi } from 'vitest';
import { annotateNativeWebSearchError, type ChatChunk } from '@calypso/chat-types';

import {
  effectiveNativeWebSearchMode,
  isNativeWebSearchCapabilityRejection,
} from '../providers/native-web-search';
import { OpenAIProcessor } from '../providers/adapters/openai-v1';
import { AnthropicProcessor } from '../providers/adapters/anthropic-v1';
import { ProviderError } from '../providers/errors';

describe('native web search routing helpers', () => {
  it('enables search only when both request and model capability opt in', () => {
    expect(
      effectiveNativeWebSearchMode({
        requested: 'auto',
        capability: { providerTool: 'openai_web_search' },
        allowedByServer: true,
      }),
    ).toBe('auto');
    expect(
      effectiveNativeWebSearchMode({
        requested: 'auto',
        capability: { providerTool: 'openai_web_search' },
      }),
    ).toBe('off');
    expect(
      effectiveNativeWebSearchMode({
        requested: 'auto',
        allowedByServer: true,
      }),
    ).toBe('off');
    expect(
      effectiveNativeWebSearchMode({
        requested: 'off',
        capability: { providerTool: 'openai_web_search' },
        allowedByServer: true,
      }),
    ).toBe('off');
    expect(
      effectiveNativeWebSearchMode({
        capability: { providerTool: 'openai_web_search' },
      }),
    ).toBe('off');
    expect(
      effectiveNativeWebSearchMode({
        requested: 'auto',
        capability: { providerTool: 'openai_web_search' },
        allowedByServer: false,
      }),
    ).toBe('off');
  });

  it('recognises provider capability errors without hiding auth and quota errors', () => {
    expect(
      isNativeWebSearchCapabilityRejection(
        'anthropic',
        new Error('web_search tool not supported for this model'),
      ),
    ).toBe(true);
    expect(
      isNativeWebSearchCapabilityRejection(
        'openai',
        new Error('OpenAI Responses API error: 403 forbidden'),
      ),
    ).toBe(false);
    expect(
      isNativeWebSearchCapabilityRejection(
        'openai',
        Object.assign(new Error('OpenAI Responses API error: 500 web_search failed'), {
          status: 500,
        }),
      ),
    ).toBe(false);
  });

  it('does not treat generic OpenAI request-shape errors as web search capability rejections', () => {
    expect(
      isNativeWebSearchCapabilityRejection(
        'openai',
        new Error("OpenAI Responses API error: 400 Unknown parameter: 'max_output_tokens'"),
      ),
    ).toBe(false);
    expect(
      isNativeWebSearchCapabilityRejection(
        'openai',
        new Error("OpenAI Responses API error: 400 Unknown parameter: 'tools[0].type' for web_search"),
      ),
    ).toBe(true);
  });

  it('native web search annotations preserve ProviderError metadata for failover', () => {
    const providerBody =
      '{"type":"rate_limit_error","message":"secret provider body"}';
    const err = new ProviderError({
      providerId: 'anthropic',
      providerName: 'Anthropic',
      status: 429,
      kind: 'rate_limit',
      retryAfterMs: 12_000,
    });
    const annotated = annotateNativeWebSearchError(err, {
      providerId: 'anthropic',
      status: 429,
      message: providerBody,
    });

    expect(annotated).toBe(err);
    expect(annotated).toBeInstanceOf(ProviderError);
    expect(annotated.kind).toBe('rate_limit');
    expect(annotated.retryAfterMs).toBe(12_000);
    expect(annotated.message).not.toContain('secret provider body');
    expect(JSON.stringify(annotated)).toBe('{}');

    const ownValues = Object.getOwnPropertyNames(annotated).map((key) =>
      String((annotated as unknown as Record<string, unknown>)[key]),
    );
    expect(ownValues.join('\n')).not.toContain('secret provider body');
  });
});

describe('native web search provider adapters', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('uses OpenAI Responses web_search and emits URL citations', async () => {
    const responseBody = [
      'data: {"type":"response.output_text.delta","response_id":"resp_1","delta":"Hello cited"}',
      'data: {"type":"response.completed","response":{"id":"resp_1","output":[{"type":"message","content":[{"type":"output_text","text":"Hello cited","annotations":[{"type":"url_citation","start_index":6,"end_index":11,"url":"https://example.com","title":"Example"}]}]}],"usage":{"input_tokens":2,"output_tokens":3}}}',
      'data: [DONE]',
      '',
    ].join('\n\n');
    const fetchMock = vi.fn().mockResolvedValue(new Response(responseBody));
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new OpenAIProcessor('https://api.openai.com/v1', 'sk-test');
    const chunks: ChatChunk[] = [];
    for await (const chunk of processor.streamChat(
      [{ role: 'user', content: 'Search this' }],
      {
        model: 'gpt-5.5',
        nativeWebSearch: 'auto',
        temperature: 0.3,
        max_tokens: 123,
      },
    )) {
      chunks.push(chunk);
    }

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/responses',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.tools).toEqual([{ type: 'web_search' }]);
    expect(body.temperature).toBe(0.3);
    expect(body.max_output_tokens).toBe(123);
    expect(chunks.some((chunk) => chunk.choices[0]?.delta.content === 'Hello cited')).toBe(true);
    expect(chunks.flatMap((chunk) => chunk.citations ?? [])).toEqual([
      expect.objectContaining({
        provider: 'openai',
        url: 'https://example.com',
        title: 'Example',
        providerStartIndex: 6,
        providerEndIndex: 11,
        providerText: 'cited',
      }),
    ]);
  });

  it('falls back to source-only OpenAI citations when astral characters make offsets ambiguous', async () => {
    const responseBody = [
      'data: {"type":"response.output_text.delta","response_id":"resp_1","delta":"🚀 cited"}',
      'data: {"type":"response.completed","response":{"id":"resp_1","output":[{"type":"message","content":[{"type":"output_text","text":"🚀 cited","annotations":[{"type":"url_citation","start_index":2,"end_index":7,"url":"https://example.com","title":"Example"}]}]}]}}',
      'data: [DONE]',
      '',
    ].join('\n\n');
    const fetchMock = vi.fn().mockResolvedValue(new Response(responseBody));
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new OpenAIProcessor('https://api.openai.com/v1', 'sk-test');
    const chunks: ChatChunk[] = [];
    for await (const chunk of processor.streamChat(
      [{ role: 'user', content: 'Search this' }],
      { model: 'gpt-5.5', nativeWebSearch: 'auto' },
    )) {
      chunks.push(chunk);
    }

    expect(chunks.flatMap((chunk) => chunk.citations ?? [])).toEqual([
      expect.objectContaining({
        url: 'https://example.com',
        providerStartIndex: undefined,
        providerEndIndex: undefined,
        providerText: undefined,
      }),
    ]);
  });

  it('keeps OpenAI BMP multibyte citation ranges when documented character indexes are unambiguous', async () => {
    const responseBody = [
      'data: {"type":"response.output_text.delta","response_id":"resp_1","delta":"Café cited"}',
      'data: {"type":"response.completed","response":{"id":"resp_1","output":[{"type":"message","content":[{"type":"output_text","text":"Café cited","annotations":[{"type":"url_citation","start_index":5,"end_index":10,"url":"https://example.com","title":"Example"}]}]}]}}',
      'data: [DONE]',
      '',
    ].join('\n\n');
    const fetchMock = vi.fn().mockResolvedValue(new Response(responseBody));
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new OpenAIProcessor('https://api.openai.com/v1', 'sk-test');
    const chunks: ChatChunk[] = [];
    for await (const chunk of processor.streamChat(
      [{ role: 'user', content: 'Search this' }],
      { model: 'gpt-5.5', nativeWebSearch: 'auto' },
    )) {
      chunks.push(chunk);
    }

    expect(chunks.flatMap((chunk) => chunk.citations ?? [])).toEqual([
      expect.objectContaining({
        url: 'https://example.com',
        providerStartIndex: 5,
        providerEndIndex: 10,
        providerText: 'cited',
      }),
    ]);
  });

  it('falls back to chat completions when OpenAI native search fails before output with a transient provider error', async () => {
    const chatCompletionsBody = [
      'data: {"id":"chat_1","choices":[{"delta":{"content":"fallback"},"finish_reason":null}]}',
      'data: [DONE]',
      '',
    ].join('\n\n');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('upstream unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response(chatCompletionsBody));
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new OpenAIProcessor('https://api.openai.com/v1', 'sk-test');
    const chunks: ChatChunk[] = [];
    for await (const chunk of processor.streamChat(
      [{ role: 'user', content: 'Search this' }],
      { model: 'gpt-5.5', nativeWebSearch: 'auto' },
    )) {
      chunks.push(chunk);
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/responses');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://api.openai.com/v1/chat/completions');
    expect(chunks.map((chunk) => chunk.choices[0]?.delta.content).filter(Boolean)).toEqual([
      'fallback',
    ]);
  });

  it('falls back to chat completions when OpenAI native search fails before output with a non-auth 4xx', async () => {
    const chatCompletionsBody = [
      'data: {"id":"chat_1","choices":[{"delta":{"content":"fallback"},"finish_reason":null}]}',
      'data: [DONE]',
      '',
    ].join('\n\n');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("Unknown parameter: 'max_output_tokens'", { status: 400 }))
      .mockResolvedValueOnce(new Response(chatCompletionsBody));
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new OpenAIProcessor('https://api.openai.com/v1', 'sk-test');
    const chunks: ChatChunk[] = [];
    for await (const chunk of processor.streamChat(
      [{ role: 'user', content: 'Search this' }],
      { model: 'gpt-5.5', nativeWebSearch: 'auto' },
    )) {
      chunks.push(chunk);
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/responses');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://api.openai.com/v1/chat/completions');
    expect(chunks.map((chunk) => chunk.choices[0]?.delta.content).filter(Boolean)).toEqual([
      'fallback',
    ]);
  });

  it('does not fall back to chat completions after OpenAI Responses has yielded output', async () => {
    const responsesBody = [
      'data: {"type":"response.output_text.delta","response_id":"resp_1","delta":"Partial"}',
      'data: {"type":"response.error","error":{"message":"web_search tool not supported after stream start"}}',
      '',
    ].join('\n\n');
    const chatCompletionsBody = [
      'data: {"id":"chat_1","choices":[{"delta":{"content":"Partial"},"finish_reason":null}]}',
      'data: [DONE]',
      '',
    ].join('\n\n');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(responsesBody))
      .mockResolvedValueOnce(new Response(chatCompletionsBody));
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new OpenAIProcessor('https://api.openai.com/v1', 'sk-test');
    const chunks: ChatChunk[] = [];

    await expect(
      (async () => {
        for await (const chunk of processor.streamChat(
          [{ role: 'user', content: 'Search this' }],
          { model: 'gpt-5.5', nativeWebSearch: 'auto' },
        )) {
          chunks.push(chunk);
        }
      })(),
    ).rejects.toThrow(/OpenAI Responses API stream error/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(chunks).toEqual([
      expect.objectContaining({
        choices: [
          expect.objectContaining({
            delta: { content: 'Partial' },
          }),
        ],
      }),
    ]);
  });

  it('uses Anthropic web_search_20260209 and emits source-list citations', async () => {
    const responseBody = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
      'data: {"type":"content_block_delta","message_id":"msg_1","delta":{"text":"Answer","citations":[{"type":"web_search_result_location","url":"https://example.com/source","title":"Source","cited_text":"source text"}]}}',
      'data: {"type":"message_delta","usage":{"output_tokens":5}}',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n\n');
    const fetchMock = vi.fn().mockResolvedValue(new Response(responseBody));
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new AnthropicProcessor('https://api.anthropic.com', 'sk-test');
    const chunks: ChatChunk[] = [];
    for await (const chunk of processor.streamChat(
      [{ role: 'user', content: 'Search this' }],
      { model: 'claude-opus-4-7', nativeWebSearch: 'auto' },
    )) {
      chunks.push(chunk);
    }

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.tools).toEqual([
      { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
    ]);
    expect(chunks.some((chunk) => chunk.choices[0]?.delta.content === 'Answer')).toBe(true);
    expect(chunks.flatMap((chunk) => chunk.citations ?? [])).toEqual([
      expect.objectContaining({
        provider: 'anthropic',
        url: 'https://example.com/source',
        title: 'Source',
        providerText: 'source text',
      }),
    ]);
  });

  it('does not fall back after Anthropic has yielded native-search output', async () => {
    let pulls = 0;
    const firstStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls === 0) {
          pulls += 1;
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"content_block_delta","message_id":"msg_1","delta":{"text":"Partial"}}\n\n',
            ),
          );
          return;
        }
        controller.error(new Error('web_search tool not supported after stream start'));
      },
    });
    const fallbackBody = [
      'data: {"type":"content_block_delta","message_id":"msg_2","delta":{"text":"Partial"}}',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n\n');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(firstStream))
      .mockResolvedValueOnce(new Response(fallbackBody));
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new AnthropicProcessor('https://api.anthropic.com', 'sk-test');
    const chunks: ChatChunk[] = [];

    await expect(
      (async () => {
        for await (const chunk of processor.streamChat(
          [{ role: 'user', content: 'Search this' }],
          { model: 'claude-opus-4-7', nativeWebSearch: 'auto' },
        )) {
          chunks.push(chunk);
        }
      })(),
    ).rejects.toThrow(/web_search tool not supported/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(chunks).toEqual([
      expect.objectContaining({
        choices: [
          expect.objectContaining({
            delta: { content: 'Partial' },
          }),
        ],
      }),
    ]);
  });
});
