import { describe, expect, it } from 'vitest';
import { extractUsageFromProviderResponse, type ProviderResponseLike } from '../usage-report';

describe('extractUsageFromProviderResponse', () => {
  it('reads OpenAI shape', () => {
    const response: ProviderResponseLike = {
      provider: 'openai',
      model: 'gpt-4o',
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    };

    expect(extractUsageFromProviderResponse(response)).toEqual({
      inputTokens: 100,
      cacheCreationInputTokens: 0,
      cachedInputTokens: 0,
      inputTokensIncludeCachedTokens: true,
      outputTokens: 50,
      model: 'gpt-4o',
      providerId: 'openai',
      providerUsagePresent: true,
    });
  });

  it('reads OpenAI cached token details without changing uncached input tokens', () => {
    const response: ProviderResponseLike = {
      provider: 'openai',
      model: 'gpt-5.5',
      usage: {
        prompt_tokens: 10_000,
        completion_tokens: 500,
        prompt_tokens_details: { cached_tokens: 8_000 },
      } as any,
    };

    expect(extractUsageFromProviderResponse(response)).toEqual({
      inputTokens: 10_000,
      cacheCreationInputTokens: 0,
      cachedInputTokens: 8_000,
      inputTokensIncludeCachedTokens: true,
      outputTokens: 500,
      model: 'gpt-5.5',
      providerId: 'openai',
      providerUsagePresent: true,
    });
  });

  it('reads Anthropic shape', () => {
    const response: ProviderResponseLike = {
      provider: 'anthropic',
      model: 'claude-3.5-sonnet',
      usage: { input_tokens: 200, output_tokens: 75 },
    };

    expect(extractUsageFromProviderResponse(response)).toEqual({
      inputTokens: 200,
      cacheCreationInputTokens: 0,
      cachedInputTokens: 0,
      inputTokensIncludeCachedTokens: false,
      outputTokens: 75,
      model: 'claude-3.5-sonnet',
      providerId: 'anthropic',
      providerUsagePresent: true,
    });
  });

  it('keeps Anthropic cache creation and cache read tokens separate', () => {
    const response: ProviderResponseLike = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      usage: {
        input_tokens: 10_000,
        cache_creation_input_tokens: 2_000,
        cache_read_input_tokens: 8_000,
        output_tokens: 500,
      } as any,
    };

    expect(extractUsageFromProviderResponse(response)).toEqual({
      inputTokens: 10_000,
      cacheCreationInputTokens: 2_000,
      cachedInputTokens: 8_000,
      inputTokensIncludeCachedTokens: false,
      outputTokens: 500,
      model: 'claude-opus-4-7',
      providerId: 'anthropic',
      providerUsagePresent: true,
    });
  });

  it('reads Gemini shape', () => {
    const response: ProviderResponseLike = {
      provider: 'google',
      model: 'gemini-1.5-pro',
      usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 100 },
    };

    expect(extractUsageFromProviderResponse(response)).toEqual({
      inputTokens: 300,
      cacheCreationInputTokens: 0,
      cachedInputTokens: 0,
      inputTokensIncludeCachedTokens: true,
      outputTokens: 100,
      model: 'gemini-1.5-pro',
      providerId: 'google',
      providerUsagePresent: true,
    });
  });

  it('reads Gemini cached content token count', () => {
    const response: ProviderResponseLike = {
      provider: 'google',
      model: 'gemini-2.5-pro',
      usageMetadata: {
        promptTokenCount: 12_000,
        cachedContentTokenCount: 6_000,
        candidatesTokenCount: 700,
      },
    };

    expect(extractUsageFromProviderResponse(response)).toEqual({
      inputTokens: 12_000,
      cacheCreationInputTokens: 0,
      cachedInputTokens: 6_000,
      inputTokensIncludeCachedTokens: true,
      outputTokens: 700,
      model: 'gemini-2.5-pro',
      providerId: 'google',
      providerUsagePresent: true,
    });
  });

  it('returns audit-gap shape when usage is missing', () => {
    const response: ProviderResponseLike = { provider: 'openai', model: 'gpt-4o' };

    expect(extractUsageFromProviderResponse(response)).toEqual({
      inputTokens: 0,
      cacheCreationInputTokens: 0,
      cachedInputTokens: 0,
      inputTokensIncludeCachedTokens: true,
      outputTokens: 0,
      model: 'gpt-4o',
      providerId: 'openai',
      providerUsagePresent: false,
    });
  });

  it('marks non-finite or negative token counts as missing usage', () => {
    const response: ProviderResponseLike = {
      provider: 'openai',
      model: 'gpt-4o',
      usage: { prompt_tokens: -1, completion_tokens: NaN },
    };

    expect(extractUsageFromProviderResponse(response)).toEqual({
      inputTokens: 0,
      cacheCreationInputTokens: 0,
      cachedInputTokens: 0,
      inputTokensIncludeCachedTokens: true,
      outputTokens: 0,
      model: 'gpt-4o',
      providerId: 'openai',
      providerUsagePresent: false,
    });
  });

  it('treats recognised zero usage as legitimate', () => {
    const response: ProviderResponseLike = {
      provider: 'openai',
      model: 'gpt-4o',
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    };

    expect(extractUsageFromProviderResponse(response)).toEqual({
      inputTokens: 0,
      cacheCreationInputTokens: 0,
      cachedInputTokens: 0,
      inputTokensIncludeCachedTokens: true,
      outputTokens: 0,
      model: 'gpt-4o',
      providerId: 'openai',
      providerUsagePresent: true,
    });
  });

  it('marks empty usage object as missing usage', () => {
    const response: ProviderResponseLike = { provider: 'openai', model: 'gpt-4o', usage: {} };

    expect(extractUsageFromProviderResponse(response).providerUsagePresent).toBe(false);
  });

  it('marks partially-present usage as missing usage', () => {
    const response: ProviderResponseLike = {
      provider: 'openai',
      model: 'gpt-4o',
      usage: { prompt_tokens: 100 },
    };

    expect(extractUsageFromProviderResponse(response).providerUsagePresent).toBe(false);
  });

  it('marks schema-drifted non-numeric usage as missing usage', () => {
    const response: ProviderResponseLike = {
      provider: 'openai',
      model: 'gpt-4o',
      usage: { prompt_tokens: 'lots' as any, completion_tokens: 'a few' as any },
    };

    expect(extractUsageFromProviderResponse(response).providerUsagePresent).toBe(false);
  });
});
