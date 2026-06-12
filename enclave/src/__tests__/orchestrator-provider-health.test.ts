import { describe, expect, it } from 'vitest';
import type { ModelCapability, ModelRouteDecision } from '@calypso/chat-types';

import { ProviderError } from '../providers/errors';
import {
  MAX_PROVIDER_COOLDOWN_MS,
  ProviderHealth,
  buildAttemptModelIds,
} from '../orchestrator/provider-health';

const models: ModelCapability[] = [
  model('gpt-5.5', 'openai'),
  model('gpt-5.4', 'openai'),
  model('claude-opus-4-7', 'anthropic'),
  model('gemini-3.1-pro-preview', 'google'),
];

const route: ModelRouteDecision = {
  subtaskId: 'st_1',
  modelId: 'gpt-5.5',
  providerId: 'openai',
  reason: 'test',
  fallbackModelIds: ['gpt-5.4', 'claude-opus-4-7', 'gemini-3.1-pro-preview'],
};

describe('ProviderHealth', () => {
  it('marks rate-limited providers as cooling and reorders attempts away from them', () => {
    const health = new ProviderHealth();
    health.mark(
      new ProviderError({
        providerId: 'openai',
        providerName: 'OpenAI',
        status: 429,
        kind: 'rate_limit',
        retryAfterMs: 30_000,
      }),
      1_000,
    );

    expect(health.isCooling('openai', 1_001)).toBe(true);
    expect(health.isCooling('openai', 31_001)).toBe(false);
    expect(buildAttemptModelIds(route, models, health, 2_000, 3)).toEqual([
      'claude-opus-4-7',
      'gemini-3.1-pro-preview',
      'gpt-5.5',
    ]);
  });

  it('keeps deterministic original order when no provider is cooling', () => {
    const health = new ProviderHealth();

    expect(buildAttemptModelIds(route, models, health, 2_000, 3)).toEqual([
      'gpt-5.5',
      'gpt-5.4',
      'claude-opus-4-7',
    ]);
  });

  it('falls back to original order when every compatible provider is cooling', () => {
    const health = new ProviderHealth();
    for (const providerId of ['openai', 'anthropic', 'google']) {
      health.mark(
        new ProviderError({
          providerId,
          providerName: providerId,
          status: 429,
          kind: 'rate_limit',
          retryAfterMs: 60_000,
        }),
        1_000,
      );
    }

    expect(buildAttemptModelIds(route, models, health, 2_000, 3)).toEqual([
      'gpt-5.5',
      'gpt-5.4',
      'claude-opus-4-7',
    ]);
  });

  it('uses Retry-After from structured provider errors when marking cooldown', () => {
    const health = new ProviderHealth();
    health.mark(
      new ProviderError({
        providerId: 'openai',
        providerName: 'OpenAI',
        status: 429,
        kind: 'rate_limit',
        retryAfterMs: 5_000,
      }),
      10_000,
    );

    expect(health.isCooling('openai', 14_999)).toBe(true);
    expect(health.isCooling('openai', 15_001)).toBe(false);
  });

  it('bounds long Retry-After values with an orchestrator-local maximum', () => {
    const health = new ProviderHealth();
    health.mark(
      new ProviderError({
        providerId: 'openai',
        providerName: 'OpenAI',
        status: 429,
        kind: 'rate_limit',
        retryAfterMs: Number.POSITIVE_INFINITY,
      }),
      10_000,
    );

    expect(health.isCooling('openai', 10_000 + MAX_PROVIDER_COOLDOWN_MS - 1))
      .toBe(true);
    expect(health.isCooling('openai', 10_000 + MAX_PROVIDER_COOLDOWN_MS + 1))
      .toBe(false);
  });

  it('skips already-attempted and newly cooling same-provider models in the same subtask', () => {
    const health = new ProviderHealth();
    health.mark(
      new ProviderError({
        providerId: 'openai',
        providerName: 'OpenAI',
        status: 429,
        kind: 'rate_limit',
        retryAfterMs: 30_000,
      }),
      1_000,
    );

    expect(
      buildAttemptModelIds(
        route,
        models,
        health,
        2_000,
        1,
        new Set(['gpt-5.5']),
      ),
    ).toEqual(['claude-opus-4-7']);
  });
});

function model(modelId: string, providerId: string): ModelCapability {
  return {
    modelId,
    providerId,
    strengths: ['general_reasoning'],
    strengthQuality: [],
    modalities: ['text_in', 'text_out'],
    endpointFamily: 'chat',
    costTier: 'medium',
    latencyTier: 'standard',
    routingStatus: 'enabled',
    requiredGatewayTools: [],
    maxContextTokens: 200_000,
  };
}
