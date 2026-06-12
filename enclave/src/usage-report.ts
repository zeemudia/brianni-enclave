export interface ProviderResponseLike {
  provider: string;
  model: string;
  cacheCreationInputTokens?: number;
  cachedInputTokens?: number;
  inputTokensIncludeCachedTokens?: boolean;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    input_tokens_details?: {
      cached_tokens?: number;
    };
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  usageMetadata?: {
    promptTokenCount?: number;
    cachedContentTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

export interface NormalisedUsage {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cachedInputTokens: number;
  inputTokensIncludeCachedTokens: boolean;
  outputTokens: number;
  model: string;
  providerId: string;
  providerUsagePresent: boolean;
}

function safeInt(value: unknown): number {
  if (!isFiniteNonNegativeNumber(value)) return 0;
  return Math.floor(value);
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function extractUsageFromProviderResponse(response: ProviderResponseLike): NormalisedUsage {
  const inputRecognised =
    isFiniteNonNegativeNumber(response.usage?.prompt_tokens) ||
    isFiniteNonNegativeNumber(response.usage?.input_tokens) ||
    isFiniteNonNegativeNumber(response.usageMetadata?.promptTokenCount);
  const outputRecognised =
    isFiniteNonNegativeNumber(response.usage?.completion_tokens) ||
    isFiniteNonNegativeNumber(response.usage?.output_tokens) ||
    isFiniteNonNegativeNumber(response.usageMetadata?.candidatesTokenCount);

  const inputCandidate =
    response.usage?.prompt_tokens ??
    response.usage?.input_tokens ??
    response.usageMetadata?.promptTokenCount ??
    0;
  const outputCandidate =
    response.usage?.completion_tokens ??
    response.usage?.output_tokens ??
    response.usageMetadata?.candidatesTokenCount ??
    0;
  const cacheCreationCandidate =
    response.cacheCreationInputTokens ?? response.usage?.cache_creation_input_tokens ?? 0;
  const cachedCandidate =
    response.cachedInputTokens ??
    response.usage?.cache_read_input_tokens ??
    response.usage?.prompt_tokens_details?.cached_tokens ??
    response.usage?.input_tokens_details?.cached_tokens ??
    response.usageMetadata?.cachedContentTokenCount ??
    0;
  const hasAnthropicCacheFields =
    response.usage?.cache_read_input_tokens !== undefined ||
    response.usage?.cache_creation_input_tokens !== undefined;
  const inputTokensIncludeCachedTokens =
    response.inputTokensIncludeCachedTokens ??
    (hasAnthropicCacheFields || response.provider === 'anthropic' ? false : true);

  return {
    inputTokens: safeInt(inputCandidate),
    cacheCreationInputTokens: safeInt(cacheCreationCandidate),
    cachedInputTokens: safeInt(cachedCandidate),
    inputTokensIncludeCachedTokens,
    outputTokens: safeInt(outputCandidate),
    model: response.model,
    providerId: response.provider,
    providerUsagePresent: inputRecognised && outputRecognised,
  };
}
