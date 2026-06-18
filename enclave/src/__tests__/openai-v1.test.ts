/**
 * B7 (docs/launch/agent-capability-verification.md): OpenAI adapter unit
 * tests, mirroring google-v1.test.ts — request/response MAPPING coverage.
 *
 * Deliberately NOT duplicated here (already covered elsewhere):
 * - mid-stream {"error":{...}} events + sanitisation → adapter-stream-errors.test.ts (H2)
 * - stalled-fetch abort on /chat/completions → adapter-stream-errors.test.ts (M1)
 * - core temperature-400 retry semantics, non-temperature 400, 429 kind,
 *   provider-metadata override → adapter-temperature-retry.test.ts
 * - Responses web_search tools flag ('auto'), URL-citation extraction
 *   (incl. astral/BMP offset edge cases), 503/non-auth-4xx pre-output
 *   fallback, no-fallback-after-output → native-web-search.test.ts
 * - usage counters in the generator return value → provider-prompt-cache.test.ts
 *
 * Note: raw fetch() rejections (DNS/socket failures) intentionally propagate
 * un-normalised from this adapter; callers normalise via
 * normaliseProviderError (orchestrator/executor.ts). Only HTTP-status and
 * SSE-event failures are classified in-adapter.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenAIProcessor } from '../providers/adapters/openai-v1';
import { ProviderError } from '../providers/errors';
import type { ChatChunk, ChatImageAttachment } from '@calypso/chat-types';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

const PROVIDER_BODY_SENTINEL = 'PROVIDER_BODY_SENTINEL_b7';

const IMAGE_ATTACHMENT: ChatImageAttachment = {
  id: 'att_1',
  kind: 'image',
  mimeType: 'image/png',
  sizeBytes: 5,
  dataBase64: 'aGVsbG8=',
};

const CHAT_OK_SSE = [
  'data: {"id":"c1","choices":[{"delta":{"content":"ok"},"finish_reason":null}]}',
  'data: [DONE]',
  '',
].join('\n');

function requestInit(
  fetchMock: ReturnType<typeof vi.fn>,
  index = 0,
): { body?: string; signal?: AbortSignal; headers?: Record<string, string> } {
  const [, init] = fetchMock.mock.calls[index] as [
    unknown,
    { body?: string; signal?: AbortSignal; headers?: Record<string, string> } | undefined,
  ];
  return init ?? {};
}

function requestBody(
  fetchMock: ReturnType<typeof vi.fn>,
  index = 0,
): Record<string, unknown> {
  return JSON.parse(String(requestInit(fetchMock, index).body ?? '{}')) as Record<
    string,
    unknown
  >;
}

async function drainWithReturn(
  gen: AsyncGenerator<ChatChunk, unknown>,
): Promise<{ chunks: ChatChunk[]; result: unknown }> {
  const chunks: ChatChunk[] = [];
  while (true) {
    const next = await gen.next();
    if (next.done) return { chunks, result: next.value };
    chunks.push(next.value);
  }
}

async function collect(
  gen: AsyncGenerator<ChatChunk, unknown>,
): Promise<{ chunks: ChatChunk[]; error: unknown }> {
  const chunks: ChatChunk[] = [];
  try {
    for await (const chunk of gen) chunks.push(chunk);
    return { chunks, error: null };
  } catch (err) {
    return { chunks, error: err };
  }
}

describe('OpenAIProcessor — token limit parameter', () => {
  it('sends a token cap as max_completion_tokens, not max_tokens (gpt-5.x rejects max_tokens)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(CHAT_OK_SSE));
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new OpenAIProcessor('https://api.openai.com/v1', 'sk-test');
    await collect(
      processor.streamChat([{ role: 'user', content: 'Hi' }], {
        model: 'gpt-5.4-mini',
        max_tokens: 256,
      }),
    );

    const body = requestBody(fetchMock);
    expect(body.max_completion_tokens).toBe(256);
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('omits both token-limit fields when no cap is requested', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(CHAT_OK_SSE));
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new OpenAIProcessor('https://api.openai.com/v1', 'sk-test');
    await collect(
      processor.streamChat([{ role: 'user', content: 'Hi' }], {
        model: 'gpt-5.4-mini',
      }),
    );

    const body = requestBody(fetchMock);
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('max_tokens');
  });
});

describe('OpenAIProcessor — chunk mapping', () => {
  it('maps SSE deltas to ChatChunks and does not yield the include_usage frame', async () => {
    const sse = [
      'data: {"id":"c1","choices":[{"delta":{"role":"assistant","content":"Hello "},"finish_reason":null}]}',
      'data: {"id":"c1","choices":[{"delta":{"content":"world!"},"finish_reason":null}]}',
      'data: {"id":"c1","choices":[{"delta":{},"finish_reason":"stop"}]}',
      'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2}}',
      'data: [DONE]',
      '',
    ].join('\n');
    const fetchMock = vi.fn().mockResolvedValue(new Response(sse));
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new OpenAIProcessor('https://api.openai.com/v1', 'sk-test');
    const { chunks, result } = await drainWithReturn(
      processor.streamChat([{ role: 'user', content: 'Hi' }], { model: 'gpt-4o' }),
    );

    // The trailing stream_options usage frame (empty choices) must be folded
    // into the return value, never surfaced as a visible chunk.
    expect(chunks.length).toBe(3);
    expect(chunks[0]).toEqual({
      id: 'c1',
      choices: [
        {
          delta: { content: 'Hello ', role: 'assistant' },
          finish_reason: null,
        },
      ],
    });
    expect(chunks[1].choices[0].delta.content).toBe('world!');
    expect(chunks[2].choices[0].finish_reason).toBe('stop');
    expect(result).toMatchObject({
      provider: 'openai',
      model: 'gpt-4o',
      usage: { prompt_tokens: 9, completion_tokens: 2 },
    });
  });

  it('reassembles SSE frames split across reads, including mid-multibyte splits', async () => {
    const sse =
      'data: {"id":"c1","choices":[{"delta":{"content":"Héllo"},"finish_reason":null}]}\ndata: [DONE]\n';
    const bytes = new TextEncoder().encode(sse);
    // Split inside the two-byte UTF-8 sequence for 'é' (0xC3 0xA9): exercises
    // both line re-buffering and TextDecoder streaming mode.
    const splitAt = bytes.indexOf(0xc3) + 1;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, splitAt));
        controller.enqueue(bytes.slice(splitAt));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body));
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new OpenAIProcessor('https://api.openai.com/v1', 'sk-test');
    const { chunks } = await drainWithReturn(
      processor.streamChat([{ role: 'user', content: 'Hi' }], { model: 'gpt-4o' }),
    );

    expect(chunks.length).toBe(1);
    expect(chunks[0].choices[0].delta.content).toBe('Héllo');
  });

  it('skips comment, event, and malformed lines without dropping later chunks', async () => {
    const sse = [
      ': keep-alive',
      'event: ping',
      'data: {definitely not json',
      'data: {"id":"c1","choices":[{"delta":{"content":"ok"},"finish_reason":null}]}',
      'data: [DONE]',
      '',
    ].join('\n');
    const fetchMock = vi.fn().mockResolvedValue(new Response(sse));
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new OpenAIProcessor('https://api.openai.com/v1', 'sk-test');
    const { chunks, error } = await collect(
      processor.streamChat([{ role: 'user', content: 'Hi' }], { model: 'gpt-4o' }),
    );

    expect(error).toBeNull();
    expect(chunks.map((c) => c.choices[0]?.delta.content)).toEqual(['ok']);
  });
});

describe('OpenAIProcessor — vision input mapping', () => {
  it('leaves text-only message content as a plain string', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(CHAT_OK_SSE));
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new OpenAIProcessor('https://api.openai.com/v1', 'sk-test');
    await drainWithReturn(
      processor.streamChat(
        [
          { role: 'system', content: 'Be helpful' },
          { role: 'user', content: 'Hi' },
        ],
        { model: 'gpt-4o' },
      ),
    );

    const body = requestBody(fetchMock);
    expect(body.messages).toEqual([
      { role: 'system', content: 'Be helpful' },
      { role: 'user', content: 'Hi' },
    ]);
    expect(requestInit(fetchMock).headers?.Authorization).toBe('Bearer sk-test');
  });

  it('encodes an image attachment as an image_url data URL part after the text part', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(CHAT_OK_SSE));
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new OpenAIProcessor('https://api.openai.com/v1', 'sk-test');
    await drainWithReturn(
      processor.streamChat(
        [
          {
            role: 'user',
            content: 'What is this?',
            attachments: [IMAGE_ATTACHMENT],
          },
        ],
        { model: 'gpt-4o' },
      ),
    );

    const body = requestBody(fetchMock);
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,aGVsbG8=' },
          },
        ],
      },
    ]);
  });

  it('omits the text part when an attached message has empty content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(CHAT_OK_SSE));
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new OpenAIProcessor('https://api.openai.com/v1', 'sk-test');
    await drainWithReturn(
      processor.streamChat(
        [{ role: 'user', content: '', attachments: [IMAGE_ATTACHMENT] }],
        { model: 'gpt-4o' },
      ),
    );

    const body = requestBody(fetchMock);
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,aGVsbG8=' },
          },
        ],
      },
    ]);
  });
});

describe('OpenAIProcessor — native web search flag', () => {
  it('stays on chat/completions with no tools when nativeWebSearch is omitted', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(CHAT_OK_SSE));
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new OpenAIProcessor('https://api.openai.com/v1', 'sk-test');
    await drainWithReturn(
      processor.streamChat([{ role: 'user', content: 'Hi' }], { model: 'gpt-4o' }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
    expect(requestBody(fetchMock)).not.toHaveProperty('tools');
  });

  it("threads the caller's abort signal into the /responses fetch", async () => {
    const sse = [
      'data: {"type":"response.output_text.delta","response_id":"r1","delta":"ok"}',
      'data: [DONE]',
      '',
    ].join('\n');
    const fetchMock = vi.fn().mockResolvedValue(new Response(sse));
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const controller = new AbortController();
    const processor = new OpenAIProcessor('https://api.openai.com/v1', 'sk-test');
    await drainWithReturn(
      processor.streamChat([{ role: 'user', content: 'Search this' }], {
        model: 'gpt-5.5',
        nativeWebSearch: 'auto',
        signal: controller.signal,
      }),
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/responses');
    expect(requestInit(fetchMock).signal).toBe(controller.signal);
  });

  it('does not fall back to chat completions on a Responses 401 (auth is not a capability failure)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(`unauthorized ${PROVIDER_BODY_SENTINEL}`, { status: 401 }),
      );
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new OpenAIProcessor('https://api.openai.com/v1', 'sk-test');
    const { error } = await collect(
      processor.streamChat([{ role: 'user', content: 'Search this' }], {
        model: 'gpt-5.5',
        nativeWebSearch: 'auto',
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ providerId: 'openai', kind: 'auth', status: 401 });
    expect((error as Error).message).toBe('OpenAI Responses API error: 401');
    expect((error as Error).message).not.toContain(PROVIDER_BODY_SENTINEL);
  });
});

describe('OpenAIProcessor — error normalization (providers/errors.ts)', () => {
  it.each([
    { status: 401, kind: 'auth' },
    { status: 403, kind: 'auth' },
    { status: 408, kind: 'transient' },
    { status: 500, kind: 'server' },
    { status: 503, kind: 'server' },
  ])('normalizes HTTP $status as a sanitised $kind ProviderError', async ({ status, kind }) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(`provider detail ${PROVIDER_BODY_SENTINEL}`, { status }),
      );
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new OpenAIProcessor('https://api.openai.com/v1', 'sk-test');
    const { error } = await collect(
      processor.streamChat([{ role: 'user', content: 'Hi' }], { model: 'gpt-4o' }),
    );

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ providerId: 'openai', kind, status });
    expect((error as Error).message).toBe(`OpenAI API error: ${status}`);
    expect((error as Error).message).not.toContain(PROVIDER_BODY_SENTINEL);
  });

  it('surfaces the provider retry-after hint as retryAfterMs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('slow down', {
        status: 429,
        headers: { 'retry-after': '7' },
      }),
    );
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new OpenAIProcessor('https://api.openai.com/v1', 'sk-test');
    const { error } = await collect(
      processor.streamChat([{ role: 'user', content: 'Hi' }], { model: 'gpt-4o' }),
    );

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: 'rate_limit', retryAfterMs: 7_000 });
  });
});

describe('OpenAIProcessor — temperature-retry interplay', () => {
  // Core retry semantics (retry happens, temperature dropped, non-temperature
  // 400 throws) are asserted in adapter-temperature-retry.test.ts. This only
  // covers what that file does not: the retry must preserve the REST of the
  // request — model, messages, stream flags, max_tokens — and the abort signal.
  it('the temperature retry preserves the rest of the request and the abort signal', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { message: "'temperature' does not support 0 with this model" },
          }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(new Response(CHAT_OK_SSE));
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const controller = new AbortController();
    const processor = new OpenAIProcessor('https://api.openai.com/v1', 'sk-test');
    const { chunks } = await drainWithReturn(
      processor.streamChat(
        [
          { role: 'system', content: 'Plan tasks' },
          { role: 'user', content: 'plan' },
        ],
        {
          model: 'gpt-5.5',
          temperature: 0,
          max_tokens: 64,
          signal: controller.signal,
        },
      ),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = requestBody(fetchMock, 0);
    const retry = requestBody(fetchMock, 1);
    expect(first.temperature).toBe(0);
    expect(retry).not.toHaveProperty('temperature');
    expect(retry.model).toBe('gpt-5.5');
    expect(retry.messages).toEqual(first.messages);
    expect(retry.stream).toBe(true);
    expect(retry.stream_options).toEqual({ include_usage: true });
    // The token cap is preserved across the retry — as max_completion_tokens
    // (gpt-5.x rejects the legacy max_tokens), never the legacy field.
    expect(retry.max_completion_tokens).toBe(64);
    expect(retry).not.toHaveProperty('max_tokens');
    expect(requestInit(fetchMock, 0).signal).toBe(controller.signal);
    expect(requestInit(fetchMock, 1).signal).toBe(controller.signal);
    expect(chunks[0]?.choices[0]?.delta.content).toBe('ok');
  });
});
