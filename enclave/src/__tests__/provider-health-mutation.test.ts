import { describe, expect, it } from 'vitest';
import type { ModelCapability, ModelRouteDecision } from '@calypso/chat-types';

import { ProviderError } from '../providers/errors';
import {
  MAX_PROVIDER_COOLDOWN_MS,
  ProviderHealth,
  buildAttemptModelIds,
} from '../orchestrator/provider-health';

/*
 * Mutation-hardening supplement for orchestrator/provider-health.ts — the
 * per-run rate-limit circuit breaker + fallback attempt ordering. Each gate
 * here changes which provider an agent subtask actually hits next:
 *   - the MIN/MAX cooldown clamp,
 *   - the `> nowMs` (strict) isCooling boundary,
 *   - the known-filter requiring BOTH in-registry AND not-already-attempted,
 *   - the active-before-cooling ordering and its `active.length > 0` fallback.
 */

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

function rateLimit(providerId: string, retryAfterMs?: number): ProviderError {
  return new ProviderError({
    providerId,
    providerName: providerId,
    status: 429,
    kind: 'rate_limit',
    retryAfterMs,
  });
}

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

describe('ProviderHealth.mark cooldown clamp', () => {
  it('clamps a tiny Retry-After up to the MIN_COOLDOWN floor (1000ms)', () => {
    const health = new ProviderHealth();
    // 10ms retry-after must be raised to the 1000ms minimum, so the provider
    // is still cooling at now+999 and clear at now+1001.
    health.mark(rateLimit('openai', 10), 0);
    expect(health.isCooling('openai', 999)).toBe(true);
    expect(health.isCooling('openai', 1001)).toBe(false);
  });

  it('clamps a huge Retry-After down to MAX_PROVIDER_COOLDOWN_MS', () => {
    const health = new ProviderHealth();
    health.mark(rateLimit('openai', 10 * MAX_PROVIDER_COOLDOWN_MS), 0);
    expect(health.isCooling('openai', MAX_PROVIDER_COOLDOWN_MS - 1)).toBe(true);
    expect(health.isCooling('openai', MAX_PROVIDER_COOLDOWN_MS + 1)).toBe(false);
  });

  it('ignores non-rate-limit errors (mark is a no-op for kind !== rate_limit)', () => {
    const health = new ProviderHealth();
    health.mark(
      new ProviderError({
        providerId: 'openai',
        providerName: 'OpenAI',
        status: 500,
        kind: 'server',
        retryAfterMs: 60_000,
      }),
      0,
    );
    expect(health.isCooling('openai', 1)).toBe(false);
  });

  it('keeps the LATER of overlapping cooldowns (Math.max(current, ...))', () => {
    const health = new ProviderHealth();
    health.mark(rateLimit('openai', 100_000), 0); // cools until 100_000
    health.mark(rateLimit('openai', 1_000), 0); // shorter — must NOT shorten
    expect(health.isCooling('openai', 99_999)).toBe(true);
  });
});

describe('ProviderHealth.isCooling boundary (> nowMs is strict)', () => {
  it('is NOT cooling at exactly the cooldown deadline', () => {
    const health = new ProviderHealth();
    health.mark(rateLimit('openai', 5_000), 10_000); // deadline = 15_000
    expect(health.isCooling('openai', 14_999)).toBe(true);
    expect(health.isCooling('openai', 15_000)).toBe(false); // == deadline ⇒ not cooling
    expect(health.isCooling('openai', 15_001)).toBe(false);
  });
});

describe('buildAttemptModelIds filters and ordering', () => {
  it('requires a model be BOTH in the registry AND not already attempted', () => {
    const health = new ProviderHealth();
    // gpt-5.5 already attempted ⇒ excluded; an unknown id in fallbacks ⇒ excluded;
    // only the registered, un-attempted ids remain in route order.
    const withUnknownFallback: ModelRouteDecision = {
      ...route,
      fallbackModelIds: ['unknown-model', 'gpt-5.4', 'claude-opus-4-7'],
    };
    expect(
      buildAttemptModelIds(
        withUnknownFallback,
        models,
        health,
        0,
        10,
        new Set(['gpt-5.5']),
      ),
    ).toEqual(['gpt-5.4', 'claude-opus-4-7']);
  });

  it('orders active providers before cooling ones, preserving original order within each group', () => {
    const health = new ProviderHealth();
    health.mark(rateLimit('openai', 30_000), 1_000); // openai cooling at t=2_000
    // active: anthropic, google (route order); cooling: openai models appended.
    expect(buildAttemptModelIds(route, models, health, 2_000, 10)).toEqual([
      'claude-opus-4-7',
      'gemini-3.1-pro-preview',
      'gpt-5.5',
      'gpt-5.4',
    ]);
  });

  it('returns the full known order when NO provider is active (active.length === 0)', () => {
    const health = new ProviderHealth();
    for (const p of ['openai', 'anthropic', 'google']) {
      health.mark(rateLimit(p, 60_000), 1_000);
    }
    // every provider cooling ⇒ active is empty ⇒ fall back to `known` order
    // (NOT the cooling-reordered list), capped by maxAttempts.
    expect(buildAttemptModelIds(route, models, health, 2_000, 10)).toEqual([
      'gpt-5.5',
      'gpt-5.4',
      'claude-opus-4-7',
      'gemini-3.1-pro-preview',
    ]);
  });

  it('de-duplicates the primary model id when it also appears in fallbacks', () => {
    const health = new ProviderHealth();
    const dupRoute: ModelRouteDecision = {
      ...route,
      fallbackModelIds: ['gpt-5.5', 'gpt-5.4'],
    };
    expect(buildAttemptModelIds(dupRoute, models, health, 0, 10)).toEqual([
      'gpt-5.5',
      'gpt-5.4',
    ]);
  });
});
