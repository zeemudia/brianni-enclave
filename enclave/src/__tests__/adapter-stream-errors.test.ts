/**
 * Error-handling audit H2 + M1.
 *
 * H2: mid-stream SSE error events ({"type":"error",...} on Anthropic,
 * {"error":{...}} on OpenAI chat-completions) were silently swallowed by
 * the per-line malformed-chunk catch, so the stream closed cleanly and a
 * TRUNCATED answer was presented as success (CHAT_DONE). They must throw
 * a classified ProviderError (sanitised message) that escapes the
 * per-line catch.
 *
 * M1: adapters ignored options.signal entirely — the research-subagent
 * AbortSignal.timeout and orchestrator worker timeouts never cancelled
 * in-flight provider work. The signal must reach fetch() (OpenAI /
 * Anthropic) and the SDK requestOptions (Google), and runAgentLoop must
 * check the signal per iteration.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AnthropicProcessor } from '../providers/adapters/anthropic-v1';
import { OpenAIProcessor } from '../providers/adapters/openai-v1';
import { ProviderError } from '../providers/errors';
import { runAgentLoop, type AgentLoopDeps } from '../agent/loop';
import { ToolGateway } from '../tools';
import type { ChatChunk, SkillPack } from '@calypso/chat-types';

const SENTINEL = 'SENSITIVE_SENTINEL_7f3a';
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function collect(
  gen: AsyncGenerator<ChatChunk, unknown>,
): Promise<{ text: string; error: unknown }> {
  let text = '';
  try {
    for await (const chunk of gen) {
      text += chunk.choices[0]?.delta.content ?? '';
    }
    return { text, error: null };
  } catch (err) {
    return { text, error: err };
  }
}

describe('H2 — Anthropic mid-stream error events', () => {
  it('throws a classified ProviderError instead of ending the stream cleanly', async () => {
    const sse = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
      'data: {"type":"content_block_delta","delta":{"text":"partial answer"}}',
      `data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded ${SENTINEL}"}}`,
      '',
    ].join('\n');
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response(sse)) as unknown as typeof global.fetch;

    const proc = new AnthropicProcessor('https://api.anthropic.com', 'sk-t');
    const { text, error } = await collect(
      proc.streamChat([{ role: 'user', content: 'hi' }], {
        model: 'claude-opus-4-7',
      }),
    );

    expect(text).toBe('partial answer');
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe('rate_limit');
    // Sanitised: the provider's error message (payload-adjacent) must not
    // ride along.
    expect((error as Error).message).not.toContain(SENTINEL);
  });

  it('still skips genuinely malformed SSE lines', async () => {
    const sse = [
      'data: {definitely not json',
      'data: {"type":"content_block_delta","delta":{"text":"ok"}}',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response(sse)) as unknown as typeof global.fetch;

    const proc = new AnthropicProcessor('https://api.anthropic.com', 'sk-t');
    const { text, error } = await collect(
      proc.streamChat([{ role: 'user', content: 'hi' }], {
        model: 'claude-opus-4-7',
      }),
    );
    expect(error).toBeNull();
    expect(text).toBe('ok');
  });
});

describe('H2 — OpenAI chat-completions mid-stream error events', () => {
  it('throws a classified ProviderError instead of ending the stream cleanly', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"partial"}}]}',
      `data: {"error":{"message":"The server had an error ${SENTINEL}","type":"server_error","code":"server_error"}}`,
      'data: [DONE]',
      '',
    ].join('\n');
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response(sse)) as unknown as typeof global.fetch;

    const proc = new OpenAIProcessor('https://api.openai.com/v1', 'sk-t');
    const { text, error } = await collect(
      proc.streamChat([{ role: 'user', content: 'hi' }], { model: 'gpt-4o' }),
    );

    expect(text).toBe('partial');
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).not.toContain(SENTINEL);
  });

  it('classifies a rate-limit error event as rate_limit', async () => {
    const sse = [
      `data: {"error":{"message":"slow down ${SENTINEL}","type":"tokens","code":"rate_limit_exceeded"}}`,
      '',
    ].join('\n');
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response(sse)) as unknown as typeof global.fetch;

    const proc = new OpenAIProcessor('https://api.openai.com/v1', 'sk-t');
    const { error } = await collect(
      proc.streamChat([{ role: 'user', content: 'hi' }], { model: 'gpt-4o' }),
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe('rate_limit');
    expect((error as Error).message).not.toContain(SENTINEL);
  });
});

describe('M1 — adapters honor options.signal', () => {
  function stalledFetch() {
    return vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(
              init.signal?.reason ??
                new DOMException('This operation was aborted', 'AbortError'),
            ),
          );
        }),
    );
  }

  it('OpenAI: a stalled fetch is aborted at the signal timeout', async () => {
    const fetchMock = stalledFetch();
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const proc = new OpenAIProcessor('https://api.openai.com/v1', 'sk-t');
    const { error } = await collect(
      proc.streamChat([{ role: 'user', content: 'hi' }], {
        model: 'gpt-4o',
        signal: AbortSignal.timeout(25),
      }),
    );
    expect(error).toBeTruthy();
    const init = fetchMock.mock.calls[0]?.[1] as { signal?: AbortSignal };
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('Anthropic: a stalled fetch is aborted at the signal timeout', async () => {
    const fetchMock = stalledFetch();
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const proc = new AnthropicProcessor('https://api.anthropic.com', 'sk-t');
    const { error } = await collect(
      proc.streamChat([{ role: 'user', content: 'hi' }], {
        model: 'claude-opus-4-7',
        signal: AbortSignal.timeout(25),
      }),
    );
    expect(error).toBeTruthy();
    const init = fetchMock.mock.calls[0]?.[1] as { signal?: AbortSignal };
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('M1 — Google adapter threads the signal into SDK requestOptions', () => {
  it('passes options.signal to sendMessageStream', async () => {
    vi.resetModules();
    const sendMessageStream = vi.fn().mockResolvedValue({
      stream: (async function* () {
        yield { text: () => 'hello' };
      })(),
      response: Promise.resolve({ usageMetadata: {} }),
    });
    vi.doMock('@google/generative-ai', () => ({
      GoogleGenerativeAI: class {
        getGenerativeModel() {
          return { startChat: () => ({ sendMessageStream }) };
        }
      },
    }));
    const { GoogleV1ChatProcessor } = await import(
      '../providers/adapters/google-v1'
    );

    const controller = new AbortController();
    const proc = new GoogleV1ChatProcessor('fake-key');
    const { error } = await collect(
      proc.streamChat([{ role: 'user', content: 'hi' }], {
        model: 'gemini-2.5-pro',
        signal: controller.signal,
      }),
    );
    expect(error).toBeNull();
    const requestOptions = sendMessageStream.mock.calls[0]?.[1] as {
      signal?: AbortSignal;
    };
    expect(requestOptions?.signal).toBe(controller.signal);
    vi.doUnmock('@google/generative-ai');
  });
});

describe('M1 — runAgentLoop observes the abort signal per iteration', () => {
  function mkPack(): SkillPack {
    return {
      id: 'personal-agent.default',
      version: 1,
      displayName: 'Default',
      description: 'test pack',
      systemPromptBlock: 'You are Calypso.',
      toolScopes: [],
      capabilitySuiteIds: ['text'],
      defaultNamespace: 'default',
      linkedFolderScopes: {},
      uiHints: { icon: 'default', accentToken: 'accent-default' },
    };
  }

  it('an already-aborted signal stops the loop before the provider is called', async () => {
    const streamChat = vi.fn();
    const deps: AgentLoopDeps = {
      gateway: new ToolGateway({ clientBridge: { invokeClient: vi.fn() } }),
      provider: { streamChat } as never,
      pack: mkPack(),
      agentTurnId: 'turn1',
      abortSignal: AbortSignal.abort(),
    };
    const gen = runAgentLoop(deps, {
      messages: [{ role: 'user', content: 'hi' }],
    });
    await expect(
      (async () => {
        for await (const ev of gen) void ev;
      })(),
    ).rejects.toThrow();
    expect(streamChat).not.toHaveBeenCalled();
  });
});
