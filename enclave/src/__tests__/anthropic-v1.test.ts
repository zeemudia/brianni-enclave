/**
 * B7 (docs/launch/agent-capability-verification.md): Anthropic adapter unit
 * tests, mirroring google-v1.test.ts — request/response MAPPING coverage.
 *
 * Deliberately NOT duplicated here (already covered elsewhere):
 * - mid-stream {"type":"error"} events (overloaded_error → rate_limit) and
 *   malformed-line skipping → adapter-stream-errors.test.ts (H2)
 * - stalled-fetch abort on /v1/messages → adapter-stream-errors.test.ts (M1)
 * - core temperature-400 retry semantics → adapter-temperature-retry.test.ts
 * - web_search_20260209 tools shape ('auto'), source-list citations,
 *   no-fallback-after-output → native-web-search.test.ts
 * - ephemeral cache_control blocks + cache usage counters in the return
 *   value → provider-prompt-cache.test.ts
 *
 * Note: raw fetch() rejections (DNS/socket failures) intentionally propagate
 * un-normalised from this adapter; callers normalise via
 * normaliseProviderError (orchestrator/executor.ts). Only HTTP-status and
 * SSE-event failures are classified in-adapter.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AnthropicProcessor } from '../providers/adapters/anthropic-v1';
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
  mimeType: 'image/jpeg',
  sizeBytes: 5,
  dataBase64: 'aGVsbG8=',
};

const MESSAGES_OK_SSE = [
  'data: {"type":"content_block_delta","message_id":"msg_1","delta":{"text":"ok"}}',
  'data: {"type":"message_stop"}',
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

describe('AnthropicProcessor — chunk mapping', () => {
  it('maps content_block_delta/message_stop events to ChatChunks and skips empty deltas', async () => {
    const sse = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":7}}}',
      'data: {"type":"content_block_delta","message_id":"msg_1","delta":{"text":"Hello "}}',
      'data: {"type":"content_block_delta","message_id":"msg_1","delta":{"text":"world!"}}',
      'data: {"type":"content_block_delta","message_id":"msg_1","delta":{"text":""}}',
      'data: {"type":"message_delta","usage":{"output_tokens":3}}',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    const fetchMock = vi.fn().mockResolvedValue(new Response(sse));
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new AnthropicProcessor('https://api.anthropic.com', 'sk-ant-test');
    const { chunks, result } = await drainWithReturn(
      processor.streamChat([{ role: 'user', content: 'Hi' }], {
        model: 'claude-opus-4-7',
      }),
    );

    // Empty text deltas produce no chunk; message_stop maps to the final
    // finish_reason chunk; usage from message_start + message_delta is merged
    // into the return value.
    expect(chunks.length).toBe(3);
    expect(chunks[0]).toEqual({
      id: 'msg_1',
      choices: [{ delta: { content: 'Hello ' }, finish_reason: null }],
    });
    expect(chunks[1].choices[0].delta.content).toBe('world!');
    expect(chunks[2]).toEqual({
      id: '',
      choices: [{ delta: {}, finish_reason: 'stop' }],
    });
    expect(result).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      usage: { input_tokens: 7, output_tokens: 3 },
    });
  });

  it('reassembles SSE frames split across reads, including mid-multibyte splits', async () => {
    const sse =
      'data: {"type":"content_block_delta","message_id":"m1","delta":{"text":"Héllo"}}\ndata: {"type":"message_stop"}\n';
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

    const processor = new AnthropicProcessor('https://api.anthropic.com', 'sk-ant-test');
    const { chunks } = await drainWithReturn(
      processor.streamChat([{ role: 'user', content: 'Hi' }], {
        model: 'claude-opus-4-7',
      }),
    );

    expect(chunks.map((c) => c.choices[0]?.delta.content ?? '').join('')).toBe('Héllo');
  });

  it('separates the system message from messages and applies the 4096 max_tokens default', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(MESSAGES_OK_SSE));
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const controller = new AbortController();
    const processor = new AnthropicProcessor('https://api.anthropic.com', 'sk-ant-test');
    await drainWithReturn(
      processor.streamChat(
        [
          { role: 'system', content: 'Be concise' },
          { role: 'user', content: 'First question' },
          { role: 'assistant', content: 'First answer' },
          { role: 'user', content: 'Follow-up' },
        ],
        { model: 'claude-opus-4-7', signal: controller.signal },
      ),
    );

    const body = requestBody(fetchMock);
    // System prompt rides the top-level `system` field (short prompt: below
    // the prompt-cache threshold, so it stays a plain string), never the
    // messages array.
    expect(body.system).toBe('Be concise');
    expect(body.messages).toEqual([
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Follow-up' },
    ]);
    expect(body.max_tokens).toBe(4096);
    expect(body.stream).toBe(true);
    expect(body).not.toHaveProperty('tools');
    const init = requestInit(fetchMock);
    expect(init.headers?.['x-api-key']).toBe('sk-ant-test');
    expect(init.headers?.['anthropic-version']).toBe('2023-06-01');
    expect(init.signal).toBe(controller.signal);
  });

  it('omits system when absent and passes max_tokens and temperature through', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(MESSAGES_OK_SSE));
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new AnthropicProcessor('https://api.anthropic.com', 'sk-ant-test');
    await drainWithReturn(
      processor.streamChat([{ role: 'user', content: 'Hi' }], {
        model: 'claude-sonnet-4-6',
        max_tokens: 512,
        temperature: 0.4,
      }),
    );

    const body = requestBody(fetchMock);
    expect(body).not.toHaveProperty('system');
    expect(body.max_tokens).toBe(512);
    expect(body.temperature).toBe(0.4);
  });
});

describe('AnthropicProcessor — vision input mapping', () => {
  it('encodes an image attachment as a base64 source block after the text block', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(MESSAGES_OK_SSE));
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new AnthropicProcessor('https://api.anthropic.com', 'sk-ant-test');
    await drainWithReturn(
      processor.streamChat(
        [
          {
            role: 'user',
            content: 'What is this?',
            attachments: [IMAGE_ATTACHMENT],
          },
        ],
        { model: 'claude-opus-4-7' },
      ),
    );

    const body = requestBody(fetchMock);
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: 'aGVsbG8=',
            },
          },
        ],
      },
    ]);
  });

  it('omits the text block when attached message content is whitespace-only', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(MESSAGES_OK_SSE));
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new AnthropicProcessor('https://api.anthropic.com', 'sk-ant-test');
    await drainWithReturn(
      processor.streamChat(
        [{ role: 'user', content: '  ', attachments: [IMAGE_ATTACHMENT] }],
        { model: 'claude-opus-4-7' },
      ),
    );

    const body = requestBody(fetchMock);
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: 'aGVsbG8=',
            },
          },
        ],
      },
    ]);
  });
});

describe('AnthropicProcessor — native web search flag', () => {
  it("omits tools when nativeWebSearch is 'off'", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(MESSAGES_OK_SSE));
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new AnthropicProcessor('https://api.anthropic.com', 'sk-ant-test');
    await drainWithReturn(
      processor.streamChat([{ role: 'user', content: 'Hi' }], {
        model: 'claude-opus-4-7',
        nativeWebSearch: 'off',
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestBody(fetchMock)).not.toHaveProperty('tools');
  });

  it('downgrades to a no-tools retry when the search tool is rejected before output', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('web_search tool not supported for this model', {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          [
            'data: {"type":"content_block_delta","message_id":"msg_2","delta":{"text":"recovered"}}',
            'data: {"type":"message_stop"}',
            '',
          ].join('\n'),
        ),
      );
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const controller = new AbortController();
    const processor = new AnthropicProcessor('https://api.anthropic.com', 'sk-ant-test');
    const { chunks, error } = await collect(
      processor.streamChat([{ role: 'user', content: 'Search this' }], {
        model: 'claude-opus-4-7',
        nativeWebSearch: 'auto',
        signal: controller.signal,
      }),
    );

    expect(error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBody(fetchMock, 0).tools).toEqual([
      { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
    ]);
    expect(requestBody(fetchMock, 1)).not.toHaveProperty('tools');
    expect(requestInit(fetchMock, 1).signal).toBe(controller.signal);
    expect(chunks.map((c) => c.choices[0]?.delta.content).filter(Boolean)).toEqual([
      'recovered',
    ]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('web search downgraded'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('web-search-tool-rejected'),
    );
  });

  it('does not downgrade on a 401: auth failures throw a normalized auth ProviderError', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(`unauthorized ${PROVIDER_BODY_SENTINEL}`, { status: 401 }),
      );
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new AnthropicProcessor('https://api.anthropic.com', 'sk-ant-test');
    const { error } = await collect(
      processor.streamChat([{ role: 'user', content: 'Search this' }], {
        model: 'claude-opus-4-7',
        nativeWebSearch: 'auto',
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      providerId: 'anthropic',
      kind: 'auth',
      status: 401,
    });
    expect((error as Error).message).toBe('Anthropic API error: 401');
    expect((error as Error).message).not.toContain(PROVIDER_BODY_SENTINEL);
  });
});

describe('AnthropicProcessor — error normalization (providers/errors.ts)', () => {
  it.each([
    { status: 401, kind: 'auth' },
    { status: 500, kind: 'server' },
    // 529 is Anthropic's "overloaded" status — must map to rate_limit so
    // provider-health cooldown (not a hard failure) handles it.
    { status: 529, kind: 'rate_limit' },
  ])('normalizes HTTP $status as a sanitised $kind ProviderError', async ({ status, kind }) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(`provider detail ${PROVIDER_BODY_SENTINEL}`, { status }),
      );
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new AnthropicProcessor('https://api.anthropic.com', 'sk-ant-test');
    const { error } = await collect(
      processor.streamChat([{ role: 'user', content: 'Hi' }], {
        model: 'claude-opus-4-7',
      }),
    );

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ providerId: 'anthropic', kind, status });
    expect((error as Error).message).toBe(`Anthropic API error: ${status}`);
    expect((error as Error).message).not.toContain(PROVIDER_BODY_SENTINEL);
  });

  it('surfaces the provider retry-after hint as retryAfterMs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('slow down', {
        status: 429,
        headers: { 'retry-after': '12' },
      }),
    );
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new AnthropicProcessor('https://api.anthropic.com', 'sk-ant-test');
    const { error } = await collect(
      processor.streamChat([{ role: 'user', content: 'Hi' }], {
        model: 'claude-opus-4-7',
      }),
    );

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: 'rate_limit', retryAfterMs: 12_000 });
  });
});

describe('AnthropicProcessor — temperature-retry interplay', () => {
  // Core retry semantics are asserted in adapter-temperature-retry.test.ts.
  // This only covers the interplay that file does not: when native web search
  // is enabled, the temperature retry must keep the tools block (dropping
  // ONLY temperature), so the retried turn is still search-capable.
  it('keeps the web-search tools block when retrying without temperature', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: '`temperature` is deprecated for this model.',
            },
          }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(new Response(MESSAGES_OK_SSE));
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new AnthropicProcessor('https://api.anthropic.com', 'sk-ant-test');
    const { chunks, error } = await collect(
      processor.streamChat([{ role: 'user', content: 'Search this' }], {
        model: 'claude-opus-4-7',
        nativeWebSearch: 'auto',
        temperature: 0,
      }),
    );

    expect(error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const expectedTools = [
      { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
    ];
    const first = requestBody(fetchMock, 0);
    const retry = requestBody(fetchMock, 1);
    expect(first.temperature).toBe(0);
    expect(first.tools).toEqual(expectedTools);
    expect(retry).not.toHaveProperty('temperature');
    expect(retry.tools).toEqual(expectedTools);
    expect(chunks.map((c) => c.choices[0]?.delta.content).filter(Boolean)).toEqual([
      'ok',
    ]);
  });
});
