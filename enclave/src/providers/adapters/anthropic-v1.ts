import type {
  ChatCitationCandidate,
  ChatProcessor,
  ChatMessage,
  ChatChunk,
} from '@calypso/chat-types';
import type { ProviderResponseLike } from '../../usage-report';
import {
  getAnnotatedNativeWebSearchFallbackReason,
  logNativeWebSearchDowngrade,
  makeNativeWebSearchProviderError,
} from '../native-web-search';
import {
  classifyProviderStreamError,
  parseRetryAfterMs,
  ProviderError,
} from '../errors';
import { buildAnthropicPromptCacheRequest } from '../prompt-cache';

export interface AnthropicCompatibleProviderMetadata {
  providerId?: string;
  providerName?: string;
}

type AnthropicContentBlock =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | {
      type: 'image';
      source: {
        type: 'base64';
        media_type: string;
        data: string;
      };
    };

function anthropicMessageContent(
  message: ChatMessage,
  cachedContent: unknown,
): unknown {
  if (!message.attachments?.length) return cachedContent;
  const blocks: AnthropicContentBlock[] = [];
  if (message.content.trim()) {
    blocks.push({ type: 'text', text: message.content });
  }
  for (const attachment of message.attachments) {
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: attachment.mimeType,
        data: attachment.dataBase64,
      },
    });
  }
  return blocks;
}

/**
 * Anthropic Messages API ChatProcessor.
 * Converts between the Calypso ChatMessage format and Anthropic's API.
 */
export class AnthropicProcessor implements ChatProcessor {
  private readonly providerId: string;
  private readonly providerName: string;

  constructor(
    private baseUrl: string,
    private apiKey: string,
    providerMetadata: AnthropicCompatibleProviderMetadata = {},
  ) {
    this.providerId = providerMetadata.providerId ?? 'anthropic';
    this.providerName = providerMetadata.providerName ?? 'Anthropic';
  }

  async *streamChat(
    messages: ChatMessage[],
    options: {
      model: string;
      temperature?: number;
      max_tokens?: number;
      signal?: AbortSignal;
      nativeWebSearch?: 'auto' | 'off';
    },
  ): AsyncGenerator<ChatChunk, ProviderResponseLike> {
    let emittedNativeSearchOutput = false;
    try {
      const stream = this.streamMessages(messages, options);
      while (true) {
        const next = await stream.next();
        if (next.done) return next.value;
        emittedNativeSearchOutput = true;
        yield next.value;
      }
    } catch (err) {
      const fallbackReason = getAnnotatedNativeWebSearchFallbackReason(
        this.providerId,
        err,
      );
      if (
        !emittedNativeSearchOutput &&
        options.nativeWebSearch === 'auto' &&
        fallbackReason
      ) {
        logNativeWebSearchDowngrade({
          providerId: this.providerId,
          model: options.model,
          reason: fallbackReason,
        });
        return yield* this.streamMessages(messages, {
          ...options,
          nativeWebSearch: 'off',
        });
      }
      throw err;
    }
  }

  private async *streamMessages(
    messages: ChatMessage[],
    options: {
      model: string;
      temperature?: number;
      max_tokens?: number;
      signal?: AbortSignal;
      nativeWebSearch?: 'auto' | 'off';
    },
  ): AsyncGenerator<ChatChunk, ProviderResponseLike> {
    // Anthropic separates system messages from the messages array
    const systemMessage = messages.find((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

    const promptCacheRequest = buildAnthropicPromptCacheRequest({
      model: options.model,
      system: systemMessage?.content,
      messages: nonSystemMessages,
    });

    const body: Record<string, unknown> = {
      model: options.model,
      messages: promptCacheRequest.messages.map((message, index) => {
        const sourceMessage = nonSystemMessages[index];
        return {
          ...message,
          content: sourceMessage
            ? anthropicMessageContent(sourceMessage, message.content)
            : message.content,
        };
      }),
      stream: true,
      max_tokens: options.max_tokens ?? 4096,
    };
    if (promptCacheRequest.system) body.system = promptCacheRequest.system;
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.nativeWebSearch === 'auto') {
      body.tools = [
        {
          type: 'web_search_20260209',
          name: 'web_search',
          max_uses: 5,
        },
      ];
    }

    const post = (): Promise<Response> =>
      fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        // M1: thread the caller's abort signal into the network request so
        // research-subagent / orchestrator timeouts actually cancel work.
        signal: options.signal,
      });

    let response = await post();

    // Reasoning/frontier models (e.g. claude-opus-4-7) reject a custom
    // `temperature` ("`temperature` is deprecated for this model"). Until this
    // PR these surfaced as a bare 400 that aborted the whole turn — and because
    // the orchestrator planner always routes to such a model, EVERY Calypso task
    // failed with ORCHESTRATOR_PLAN_FAILED. Detect the temperature-specific 400
    // and retry once without the parameter instead of hard-failing.
    if (response.status === 400 && 'temperature' in body) {
      const errorBody = await response.text().catch(() => '');
      if (/temperature/i.test(errorBody)) {
        delete body.temperature;
        response = await post();
      } else {
        throw makeNativeWebSearchProviderError({
          providerId: this.providerId,
          providerName: this.providerName,
          status: 400,
          providerBody: errorBody,
          retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
        });
      }
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw makeNativeWebSearchProviderError({
        providerId: this.providerId,
        providerName: this.providerName,
        status: response.status,
        providerBody: errorBody,
        retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
      });
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    const finalUsage: ProviderResponseLike['usage'] = {};

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();

          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'error') {
              // H2: a mid-stream error event means the answer is
              // TRUNCATED. It used to fall through every branch and be
              // dropped, letting the stream end "cleanly" (CHAT_DONE).
              // Throw a classified, sanitised ProviderError instead —
              // rethrown past the malformed-chunk catch below.
              throw classifyProviderStreamError({
                providerId: this.providerId,
                providerName: this.providerName,
                errorType: parsed.error?.type,
              });
            }
            if (parsed.type === 'message_start' && parsed.message?.usage) {
              mergeAnthropicUsage(finalUsage, parsed.message.usage);
            } else if (parsed.type === 'message_delta' && parsed.usage) {
              mergeAnthropicUsage(finalUsage, parsed.usage);
            } else if (parsed.type === 'content_block_start') {
              const citations = extractAnthropicCitations(
                parsed.content_block,
                this.providerId,
              );
              if (citations.length > 0) {
                yield {
                  id: parsed.message_id ?? '',
                  choices: [{ delta: {}, finish_reason: null }],
                  citations,
                };
              }
            } else if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              const chunk: ChatChunk = {
                id: parsed.message_id ?? '',
                choices: [
                  {
                    delta: { content: parsed.delta.text },
                    finish_reason: null,
                  },
                ],
              };
              yield chunk;
              const citations = extractAnthropicCitations(
                parsed.delta,
                this.providerId,
              );
              if (citations.length > 0) {
                yield {
                  id: parsed.message_id ?? '',
                  choices: [{ delta: {}, finish_reason: null }],
                  citations,
                };
              }
            } else if (parsed.type === 'message_stop') {
              const chunk: ChatChunk = {
                id: '',
                choices: [
                  {
                    delta: {},
                    finish_reason: 'stop',
                  },
                ],
              };
              yield chunk;
            }
          } catch (err) {
            // H2: classified mid-stream failures must escape the stream;
            // only genuinely malformed SSE lines are skipped.
            if (err instanceof ProviderError) throw err;
            // Skip malformed chunks
          }
        }
      }
      return { provider: this.providerId, model: options.model, usage: finalUsage };
    } finally {
      reader.releaseLock();
    }
  }
}

function mergeAnthropicUsage(
  target: NonNullable<ProviderResponseLike['usage']>,
  usage: unknown,
): void {
  if (!usage || typeof usage !== 'object') return;
  const usageObject = usage as Record<string, unknown>;
  copyAnthropicNumberField(target, usageObject, 'input_tokens');
  copyAnthropicNumberField(target, usageObject, 'output_tokens');
  copyAnthropicNumberField(target, usageObject, 'cache_creation_input_tokens');
  copyAnthropicNumberField(target, usageObject, 'cache_read_input_tokens');
}

function copyAnthropicNumberField(
  target: NonNullable<ProviderResponseLike['usage']>,
  source: Record<string, unknown>,
  field:
    | 'input_tokens'
    | 'output_tokens'
    | 'cache_creation_input_tokens'
    | 'cache_read_input_tokens',
): void {
  const value = source[field];
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    target[field] = value;
  }
}

function extractAnthropicCitations(
  value: unknown,
  providerId = 'anthropic',
): ChatCitationCandidate[] {
  const citations = Array.isArray((value as { citations?: unknown }).citations)
    ? ((value as { citations: unknown[] }).citations)
    : [];

  const out: ChatCitationCandidate[] = [];
  const seen = new Set<string>();
  for (const citation of citations) {
    const c = citation as Record<string, unknown>;
    const url = typeof c.url === 'string' ? c.url : undefined;
    if (!url) continue;
    const title = typeof c.title === 'string' ? c.title : undefined;
    const providerText = typeof c.cited_text === 'string' ? c.cited_text : undefined;
    const key = `${url}:${title ?? ''}:${providerText ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      url,
      title,
      provider: providerId,
      providerText,
    });
  }

  return out;
}
