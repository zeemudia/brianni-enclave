import { GoogleGenerativeAI } from '@google/generative-ai';
import type {
  ChatCitationCandidate,
  ChatProcessor,
  ChatMessage,
  ChatChunk,
} from '@calypso/chat-types';
import { webcrypto } from 'node:crypto';
import type { ProviderResponseLike } from '../../usage-report';
import {
  getAnnotatedNativeWebSearchFallbackReason,
  logNativeWebSearchDowngrade,
} from '../native-web-search';
import { normaliseProviderError } from '../errors';
import { buildGeminiPrivatePromptCacheOptions } from '../prompt-cache';

export interface GoogleCompatibleProviderMetadata {
  providerId?: string;
  providerName?: string;
}

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

function geminiPartsForMessage(message: ChatMessage): GeminiPart[] {
  const parts: GeminiPart[] = [];
  if (message.content.trim()) parts.push({ text: message.content });
  for (const attachment of message.attachments ?? []) {
    parts.push({
      inlineData: {
        mimeType: attachment.mimeType,
        data: attachment.dataBase64,
      },
    });
  }
  return parts.length > 0 ? parts : [{ text: '' }];
}

export class GoogleV1ChatProcessor implements ChatProcessor {
  private genAI: GoogleGenerativeAI;
  private readonly providerId: string;
  private readonly providerName: string;

  constructor(
    apiKey: string,
    baseUrl?: string,
    providerMetadata: GoogleCompatibleProviderMetadata = {},
  ) {
    this.providerId = providerMetadata.providerId ?? 'google';
    this.providerName = providerMetadata.providerName ?? 'Google';
    this.genAI = new GoogleGenerativeAI(apiKey);
    // On Nitro, the vsock bridge intercepts DNS resolution for this host,
    // so the SDK's default URL works transparently. The baseUrl parameter
    // is available for custom endpoint configuration if needed.
    if (baseUrl) {
      // @google/generative-ai supports custom base URL via internal property
      (this.genAI as any).apiClient = baseUrl;
    }
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
      const stream = this.streamGemini(messages, options);
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
        return yield* this.streamGemini(messages, {
          ...options,
          nativeWebSearch: 'off',
        });
      }
      // H1: ALWAYS normalise — even after output was emitted. The raw
      // Google SDK error can embed request-derived content in its message;
      // normaliseProviderError keeps existing ProviderErrors as-is and
      // wraps anything else with a sanitised, fixed-format message.
      throw normaliseProviderError(err, this.providerId, this.providerName);
    }
  }

  private async *streamGemini(
    messages: ChatMessage[],
    options: {
      model: string;
      temperature?: number;
      max_tokens?: number;
      signal?: AbortSignal;
      nativeWebSearch?: 'auto' | 'off';
    },
  ): AsyncGenerator<ChatChunk, ProviderResponseLike> {
    // Convert to Gemini format: system instruction + history + last user message
    const systemInstruction = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');

    const modelConfig: Record<string, unknown> = {
      model: options.model,
      generationConfig: {
        temperature: options.temperature,
        maxOutputTokens: options.max_tokens,
      },
      ...buildGeminiPrivatePromptCacheOptions({ model: options.model })
        .requestOptions,
      // Set the system instruction at the model level: getGenerativeModel()
      // runs formatSystemInstruction() to wrap the string in a Content object.
      // Passing it via startChat() instead leaves it as a raw string, which the
      // SDK's ChatSession forwards unformatted — stricter model endpoints
      // (e.g. gemini-*-flash-lite) reject that with
      // "400 Invalid value at 'system_instruction' (...Content)".
      ...(systemInstruction ? { systemInstruction } : {}),
    };
    if (options.nativeWebSearch === 'auto') {
      modelConfig.tools = [{ googleSearch: {} }];
    }

    const model = this.genAI.getGenerativeModel(modelConfig as any);

    const nonSystemMessages = messages.filter((m) => m.role !== 'system');
    const lastUserMessage = nonSystemMessages[nonSystemMessages.length - 1]?.content || '';

    const history = nonSystemMessages.slice(0, -1).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: geminiPartsForMessage(m),
    }));

    const chat = model.startChat({ history });

    // M1: the SDK supports per-request cancellation via
    // SingleRequestOptions.signal (@google/generative-ai >= 0.20) — thread
    // the caller's abort signal so research-subagent / orchestrator
    // timeouts actually cancel the underlying network request.
    const lastMessage = nonSystemMessages[nonSystemMessages.length - 1];
    const requestMessage = lastMessage?.attachments?.length
      ? geminiPartsForMessage(lastMessage)
      : lastUserMessage;
    const result = await chat.sendMessageStream(
      requestMessage as any,
      options.signal ? { signal: options.signal } : undefined,
    );
    const streamId = `chatcmpl-${webcrypto.randomUUID()}`;
    let fullText = '';

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) {
        fullText += text;
        yield {
          id: streamId,
          choices: [{ delta: { content: text }, finish_reason: null }],
        };
      }
    }

    const finalResponse = await result.response;
    const citations = googleGroundingCitations(
      finalResponse,
      fullText,
      this.providerId,
    );
    if (citations.length > 0) {
      yield {
        id: streamId,
        choices: [{ delta: {}, finish_reason: null }],
        citations,
      };
    }

    yield {
      id: streamId,
      choices: [{ delta: {}, finish_reason: 'stop' }],
    };

    return {
      provider: this.providerId,
      model: options.model,
      usageMetadata: finalResponse?.usageMetadata,
    };
  }
}

export function googleGroundingCitations(
  response: unknown,
  fullText: string,
  providerId = 'google',
): ChatCitationCandidate[] {
  const responseObject =
    response && typeof response === 'object'
      ? (response as { candidates?: unknown })
      : {};
  const candidates = Array.isArray(responseObject.candidates)
    ? ((response as { candidates: unknown[] }).candidates)
    : [];
  const groundingMetadata = (candidates[0] as { groundingMetadata?: unknown } | undefined)
    ?.groundingMetadata as
    | {
        groundingChunks?: Array<{ web?: { uri?: unknown; title?: unknown } }>;
        groundingSupports?: Array<{
          segment?: { startIndex?: unknown; endIndex?: unknown; text?: unknown };
          groundingChunkIndices?: unknown;
        }>;
      }
    | undefined;

  const chunks = groundingMetadata?.groundingChunks ?? [];
  const supports = groundingMetadata?.groundingSupports ?? [];
  const out: ChatCitationCandidate[] = [];
  const seen = new Set<string>();
  const offsetMap = buildUtf8ByteOffsetToUtf16IndexMap(fullText);

  for (const support of supports) {
    const indices = Array.isArray(support.groundingChunkIndices)
      ? support.groundingChunkIndices
      : [];
    const providerStartIndex =
      typeof support.segment?.startIndex === 'number'
        ? utf8ByteOffsetToUtf16Index(offsetMap, support.segment.startIndex)
        : undefined;
    const providerEndIndex =
      typeof support.segment?.endIndex === 'number'
        ? utf8ByteOffsetToUtf16Index(offsetMap, support.segment.endIndex)
        : undefined;
    const providerText =
      typeof support.segment?.text === 'string'
        ? support.segment.text
        : providerStartIndex !== undefined && providerEndIndex !== undefined
          ? fullText.slice(providerStartIndex, providerEndIndex)
          : undefined;

    for (const index of indices) {
      if (typeof index !== 'number') continue;
      const web = chunks[index]?.web;
      const url = typeof web?.uri === 'string' ? web.uri : undefined;
      if (!url) continue;
      const title = typeof web?.title === 'string' ? web.title : undefined;
      const key = `${url}:${providerStartIndex ?? ''}:${providerEndIndex ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        url,
        title,
        provider: providerId,
        providerStartIndex,
        providerEndIndex,
        providerText,
      });
    }
  }

  return out;
}

function utf8ByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function buildUtf8ByteOffsetToUtf16IndexMap(text: string): number[] {
  const map: number[] = [0];
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const nextIndex = index + (codePoint > 0xffff ? 2 : 1);
    const nextBytes = bytes + utf8ByteLength(codePoint);
    for (let byte = bytes; byte < nextBytes; byte += 1) {
      map[byte] = index;
    }
    bytes = nextBytes;
    map[bytes] = nextIndex;
    if (codePoint > 0xffff) index += 1;
  }
  return map;
}

function utf8ByteOffsetToUtf16Index(offsetMap: readonly number[], byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  return offsetMap[Math.min(byteOffset, offsetMap.length - 1)] ?? 0;
}
