import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenAIProcessor } from '../providers/adapters/openai-v1';
import { AnthropicProcessor } from '../providers/adapters/anthropic-v1';
import { ProviderError } from '../providers/errors';

/**
 * Regression: reasoning/frontier models reject a custom `temperature`
 * (OpenAI gpt-5.5: "does not support 0 ... Only the default (1) value is
 * supported"; Anthropic claude-opus-4-7: "`temperature` is deprecated for this
 * model"). Because the orchestrator planner always routes to one of these
 * models, the resulting 400 aborted EVERY Calypso task with
 * ORCHESTRATOR_PLAN_FAILED. The adapters must drop `temperature` and retry once
 * instead of hard-failing.
 */

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function bodyOf(call: unknown): string {
  const init = (call as [unknown, { body?: string }])[1];
  return init?.body ?? '';
}

async function drain(
  gen: AsyncGenerator<{ choices: { delta: { content?: string } }[] }, unknown>,
): Promise<string> {
  let out = '';
  for await (const chunk of gen) {
    out += chunk.choices[0]?.delta.content ?? '';
  }
  return out;
}

describe('adapter temperature-rejection retry', () => {
  it('OpenAI: retries without temperature on a temperature 400, then streams', async () => {
    const ok =
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message:
                "Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported.",
            },
          }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(new Response(ok));
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const proc = new OpenAIProcessor('https://api.openai.com/v1', 'sk-test');
    const out = await drain(
      proc.streamChat([{ role: 'user', content: 'plan' }], {
        model: 'gpt-5.5',
        temperature: 0,
      }) as never,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock.mock.calls[0])).toContain('"temperature"');
    expect(bodyOf(fetchMock.mock.calls[1])).not.toContain('"temperature"');
    expect(out).toBe('hi');
  });

  it('Anthropic: retries without temperature on a temperature 400, then streams', async () => {
    const ok =
      'data: {"type":"content_block_delta","delta":{"text":"hi"}}\n\ndata: {"type":"message_stop"}\n\n';
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
      .mockResolvedValueOnce(new Response(ok));
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const proc = new AnthropicProcessor('https://api.anthropic.com', 'sk-ant-test');
    const out = await drain(
      proc.streamChat([{ role: 'user', content: 'plan' }], {
        model: 'claude-opus-4-7',
        temperature: 0,
      }) as never,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock.mock.calls[0])).toContain('"temperature"');
    expect(bodyOf(fetchMock.mock.calls[1])).not.toContain('"temperature"');
    expect(out).toBe('hi');
  });

  it('OpenAI: a non-temperature 400 still throws (no silent retry)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'bad model' } }), {
          status: 400,
        }),
      );
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const proc = new OpenAIProcessor('https://api.openai.com/v1', 'sk-test');
    await expect(
      drain(
        proc.streamChat([{ role: 'user', content: 'x' }], {
          model: 'gpt-5.5',
          temperature: 0,
        }) as never,
      ),
    ).rejects.toThrow(/OpenAI API error: 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('OpenAI: wraps 429 as sanitized ProviderError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            '{"error":{"message":"private body","type":"rate_limit"}}',
            { status: 429 },
          ),
      ),
    );
    const processor = new OpenAIProcessor('https://api.openai.test', 'sk-test');
    const stream = processor.streamChat([{ role: 'user', content: 'hi' }], {
      model: 'gpt-test',
    });

    let thrown: unknown;
    try {
      await stream.next();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProviderError);
    expect(thrown).toMatchObject({
      name: 'ProviderError',
      providerId: 'openai',
      status: 429,
      kind: 'rate_limit',
    });
  });

  it('OpenAI-compatible adapters report the configured provider id and name', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            '{"error":{"message":"private body","type":"rate_limit"}}',
            { status: 429 },
          ),
      ),
    );
    const processor = new OpenAIProcessor(
      'https://api.x.ai/v1',
      'xai-test-key',
      { providerId: 'xai', providerName: 'xAI' },
    );
    const stream = processor.streamChat([{ role: 'user', content: 'hi' }], {
      model: 'grok-test-fixture',
    });

    let thrown: unknown;
    try {
      await stream.next();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProviderError);
    expect(thrown).toMatchObject({
      name: 'ProviderError',
      providerId: 'xai',
      status: 429,
      kind: 'rate_limit',
    });
    expect((thrown as Error).message).toBe('xAI API error: 429');
  });
});
