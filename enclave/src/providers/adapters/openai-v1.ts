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
  makeNativeWebSearchProviderStreamError,
} from '../native-web-search';
import {
  classifyProviderHttpError,
  classifyProviderStreamError,
  parseRetryAfterMs,
  ProviderError,
} from '../errors';
import { buildOpenAIPrivatePromptCacheOptions } from '../prompt-cache';

export interface OpenAICompatibleProviderMetadata {
  providerId?: string;
  providerName?: string;
}

type OpenAIMessageContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >;

function openAIMessageContent(message: ChatMessage): OpenAIMessageContent {
  if (!message.attachments?.length) return message.content;
  return [
    ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
    ...message.attachments.map((attachment) => ({
      type: 'image_url' as const,
      image_url: {
        url: `data:${attachment.mimeType};base64,${attachment.dataBase64}`,
      },
    })),
  ];
}

function openAIChatMessages(messages: ChatMessage[]) {
  return messages.map((message) => ({
    role: message.role,
    content: openAIMessageContent(message),
  }));
}

/**
 * OpenAI-compatible ChatProcessor.
 * Uses the OpenAI Chat Completions streaming API.
 */
export class OpenAIProcessor implements ChatProcessor {
  private readonly providerId: string;
  private readonly providerName: string;

  constructor(
    private baseUrl: string,
    private apiKey: string,
    providerMetadata: OpenAICompatibleProviderMetadata = {},
  ) {
    this.providerId = providerMetadata.providerId ?? 'openai';
    this.providerName = providerMetadata.providerName ?? 'OpenAI';
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
    if (options.nativeWebSearch === 'auto') {
      let emittedResponsesOutput = false;
      try {
        const responsesStream = this.streamResponsesWithWebSearch(messages, options);
        while (true) {
          const next = await responsesStream.next();
          if (next.done) return next.value;
          emittedResponsesOutput = true;
          yield next.value;
        }
      } catch (err) {
        const fallbackReason = getAnnotatedNativeWebSearchFallbackReason(
          this.providerId,
          err,
        );
        if (emittedResponsesOutput || !fallbackReason) {
          throw err;
        }
        logNativeWebSearchDowngrade({
          providerId: this.providerId,
          model: options.model,
          reason: fallbackReason,
        });
      }
    }

    const buildBody = (includeTemperature: boolean): string => {
      const { requestOptions: promptCacheOptions } =
        buildOpenAIPrivatePromptCacheOptions({ model: options.model });
      return JSON.stringify({
        model: options.model,
        messages: openAIChatMessages(messages),
        stream: true,
        stream_options: { include_usage: true },
        ...promptCacheOptions,
        ...(includeTemperature &&
          options.temperature !== undefined && {
            temperature: options.temperature,
        }),
        ...(options.max_tokens !== undefined && { max_tokens: options.max_tokens }),
      });
    };

    const post = (body: string): Promise<Response> =>
      fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body,
        // M1: thread the caller's abort signal into the network request so
        // research-subagent / orchestrator timeouts actually cancel work.
        signal: options.signal,
      });

    let response = await post(buildBody(true));

    // Reasoning/frontier models (e.g. gpt-5.5) reject a custom `temperature`
    // ("does not support 0 with this model. Only the default (1) value is
    // supported"). Until this PR these surfaced as a bare 400 that aborted the
    // whole turn — and because the orchestrator planner always routes to such a
    // model, EVERY Calypso task failed with ORCHESTRATOR_PLAN_FAILED. Detect the
    // temperature-specific 400 and retry once without the parameter instead of
    // hard-failing.
    if (response.status === 400 && options.temperature !== undefined) {
      const errorBody = await response.text().catch(() => '');
      if (/temperature/i.test(errorBody)) {
        response = await post(buildBody(false));
      } else {
        throw classifyProviderHttpError({
          providerId: this.providerId,
          providerName: this.providerName,
          status: 400,
          body: errorBody,
          retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
        });
      }
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw classifyProviderHttpError({
        providerId: this.providerId,
        providerName: this.providerName,
        status: response.status,
        body,
        retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
      });
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let finalUsage: ProviderResponseLike['usage'] | undefined;

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
          if (data === '[DONE]') {
            return { provider: this.providerId, model: options.model, usage: finalUsage };
          }

          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              // H2: mid-stream error events mean the answer is TRUNCATED.
              // They used to parse cleanly, match no branch, and vanish —
              // the stream then ended "successfully". Mirror the
              // Responses-API path: throw a classified, sanitised
              // ProviderError that escapes the malformed-chunk catch.
              throw classifyProviderStreamError({
                providerId: this.providerId,
                providerName: this.providerName,
                errorType: parsed.error?.type,
                errorCode: parsed.error?.code,
              });
            }
            if (parsed.usage && typeof parsed.usage === 'object') {
              finalUsage = parsed.usage;
              if (!Array.isArray(parsed.choices) || parsed.choices.length === 0) continue;
            }
            const chunk: ChatChunk = {
              id: parsed.id ?? '',
              choices: (parsed.choices ?? []).map(
                (c: { delta?: { content?: string; role?: string }; finish_reason?: string | null }) => ({
                  delta: {
                    content: c.delta?.content,
                    role: c.delta?.role,
                  },
                  finish_reason: c.finish_reason ?? null,
                }),
              ),
            };
            yield chunk;
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

  private async *streamResponsesWithWebSearch(
    messages: ChatMessage[],
    options: {
      model: string;
      temperature?: number;
      max_tokens?: number;
      signal?: AbortSignal;
    },
  ): AsyncGenerator<ChatChunk, ProviderResponseLike> {
    const response = await fetch(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      // M1: same cancellation contract as the chat-completions path.
      signal: options.signal,
      body: JSON.stringify({
        model: options.model,
        input: messages.map((message) => ({
          role: message.role,
          content: openAIMessageContent(message),
        })),
        tools: [{ type: 'web_search' }],
        stream: true,
        ...buildOpenAIPrivatePromptCacheOptions({ model: options.model })
          .requestOptions,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.max_tokens !== undefined ? { max_output_tokens: options.max_tokens } : {}),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw makeNativeWebSearchProviderError({
        providerId: this.providerId,
        providerName: `${this.providerName} Responses`,
        status: response.status,
        providerBody: body,
        retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
      });
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let finalUsage: ProviderResponseLike['usage'] | undefined;

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
          if (data === '[DONE]') {
            return { provider: this.providerId, model: options.model, usage: finalUsage };
          }

          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'response.output_text.delta' && typeof parsed.delta === 'string') {
              fullText += parsed.delta;
              yield {
                id: parsed.response_id ?? parsed.item_id ?? '',
                choices: [
                  {
                    delta: { content: parsed.delta },
                    finish_reason: null,
                  },
                ],
              };
            } else if (parsed.type === 'response.completed' && parsed.response) {
              finalUsage = parsed.response.usage;
              const citations = extractOpenAIResponseCitations(
                parsed.response,
                fullText,
                this.providerId,
              );
              if (citations.length > 0) {
                yield {
                  id: parsed.response.id ?? '',
                  choices: [{ delta: {}, finish_reason: null }],
                  citations,
                };
              }
            } else if (parsed.type === 'response.error' || parsed.error) {
              throw makeNativeWebSearchProviderStreamError({
                providerId: this.providerId,
                providerName: `${this.providerName} Responses`,
                providerBody: JSON.stringify(parsed.error ?? parsed),
              });
            }
          } catch (err) {
            if (
              err instanceof Error &&
              err.message.endsWith('Responses API stream error')
            ) {
              throw err;
            }
            // Skip malformed chunks.
          }
        }
      }
      return { provider: this.providerId, model: options.model, usage: finalUsage };
    } finally {
      reader.releaseLock();
    }
  }
}

function extractOpenAIResponseCitations(
  response: unknown,
  fallbackText: string,
  providerId = 'openai',
): ChatCitationCandidate[] {
  const out: ChatCitationCandidate[] = [];
  const seen = new Set<string>();
  const output = Array.isArray((response as { output?: unknown }).output)
    ? ((response as { output: unknown[] }).output)
    : [];

  for (const item of output) {
    const content = Array.isArray((item as { content?: unknown }).content)
      ? ((item as { content: unknown[] }).content)
      : [];
    for (const part of content) {
      const text =
        typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : fallbackText;
      const annotations = Array.isArray((part as { annotations?: unknown }).annotations)
        ? ((part as { annotations: unknown[] }).annotations)
        : [];
      const codePointIndexMap = buildCodePointOffsetToUtf16IndexMap(text);
      for (const annotation of annotations) {
        const direct = annotation as Record<string, unknown>;
        const nested =
          direct.url_citation && typeof direct.url_citation === 'object'
            ? (direct.url_citation as Record<string, unknown>)
            : direct;
        const url = typeof nested.url === 'string' ? nested.url : undefined;
        if (!url) continue;

        const rawStartIndex =
          typeof nested.start_index === 'number'
            ? nested.start_index
            : typeof direct.start_index === 'number'
              ? direct.start_index
              : undefined;
        const rawEndIndex =
          typeof nested.end_index === 'number'
            ? nested.end_index
            : typeof direct.end_index === 'number'
              ? direct.end_index
              : undefined;
        const range = normaliseOpenAICitationRange(
          text,
          codePointIndexMap,
          rawStartIndex,
          rawEndIndex,
        );
        const startIndex = range?.startIndex;
        const endIndex = range?.endIndex;
        const title = typeof nested.title === 'string' ? nested.title : undefined;
        const key = `${url}:${startIndex ?? ''}:${endIndex ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          url,
          title,
          provider: providerId,
          providerStartIndex: startIndex,
          providerEndIndex: endIndex,
          providerText:
            startIndex !== undefined && endIndex !== undefined
              ? text.slice(startIndex, endIndex)
              : undefined,
        });
      }
    }
  }

  return out;
}

function buildCodePointOffsetToUtf16IndexMap(text: string): number[] {
  const map: number[] = [0];
  let codePointOffset = 0;
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const nextIndex = index + (codePoint > 0xffff ? 2 : 1);
    codePointOffset += 1;
    map[codePointOffset] = nextIndex;
    if (codePoint > 0xffff) index += 1;
  }
  return map;
}

function codePointOffsetToUtf16Index(
  offsetMap: readonly number[],
  offset: number,
): number {
  if (offset <= 0) return 0;
  return offsetMap[Math.min(offset, offsetMap.length - 1)] ?? 0;
}

function normaliseOpenAICitationRange(
  text: string,
  codePointIndexMap: readonly number[],
  rawStartIndex: number | undefined,
  rawEndIndex: number | undefined,
): { startIndex: number; endIndex: number } | undefined {
  if (rawStartIndex === undefined || rawEndIndex === undefined) return undefined;

  const codePointStart = codePointOffsetToUtf16Index(codePointIndexMap, rawStartIndex);
  const codePointEnd = codePointOffsetToUtf16Index(codePointIndexMap, rawEndIndex);
  const utf16Start = rawStartIndex;
  const utf16End = rawEndIndex;
  if (codePointStart === utf16Start && codePointEnd === utf16End) {
    return { startIndex: utf16Start, endIndex: utf16End };
  }

  // OpenAI documents web-search citation annotations as start/end
  // character indexes in the model response:
  // https://developers.openai.com/api/docs/guides/tools-web-search#output-and-citations
  // JavaScript cannot distinguish code-point vs UTF-16 "character"
  // indexes once astral characters appear before the cited range. To
  // avoid persistent misattribution, keep the citation as source-only
  // whenever those interpretations diverge.
  return undefined;
}
