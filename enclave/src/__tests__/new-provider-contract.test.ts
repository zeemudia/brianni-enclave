import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildModelCapabilities } from '../orchestrator/model-capabilities';
import { selectModelForSubtask } from '../orchestrator/router';
import {
  buildProviderDisplayNameMap,
  resolveProviderDisplayName,
  type ProviderDisplayNameConfig,
} from '../providers/display-name';
import {
  classifyProviderHttpError,
  parseRetryAfterMs,
} from '../providers/errors';
import type { ProviderConfig } from '../providers/registry';
import { getRoutableModelCapabilities } from '../index';

const __dirname = dirname(fileURLToPath(import.meta.url));
const providersWithXaiPath = resolve(
  __dirname,
  '../providers/__fixtures__/providers.with-xai.json',
);
describe('new provider failover contract', () => {
  it('uses registry display names when present and stable human fallbacks otherwise', () => {
    const displayNames = buildProviderDisplayNameMap([
      provider('mistral_ai', '  Mistral AI  '),
      provider('xai'),
      provider('openai_realtime'),
      provider('aws-bedrock'),
      provider('gcp_vertex_api'),
      provider('blank-name', '   '),
      provider('null-name', null),
    ]);

    expect(resolveProviderDisplayName('mistral_ai', displayNames)).toBe(
      'Mistral AI',
    );
    expect(resolveProviderDisplayName('xai', displayNames)).toBe('xAI');
    expect(resolveProviderDisplayName('openai_realtime', displayNames)).toBe(
      'OpenAI Realtime',
    );
    expect(resolveProviderDisplayName('aws-bedrock', displayNames)).toBe(
      'AWS Bedrock',
    );
    expect(resolveProviderDisplayName('gcp_vertex_api', displayNames)).toBe(
      'GCP Vertex API',
    );
    expect(resolveProviderDisplayName('blank-name', displayNames)).toBe(
      'Blank Name',
    );
    expect(resolveProviderDisplayName('null-name', displayNames)).toBe(
      'Null Name',
    );
    expect(resolveProviderDisplayName('---')).toBe('---');
    expect(resolveProviderDisplayName('future-provider')).toBe(
      'Future Provider',
    );
  });

  it('key-gates a newly registered provider and includes it in provider-diverse fallbacks', () => {
    const providers = loadXaiFixture();
    const capabilities = buildModelCapabilities(providers);

    expect(
      getRoutableModelCapabilities(capabilities, new Set(['openai', 'google']))
        .map((model) => model.modelId)
        .sort(),
    ).not.toContain('grok-test-fixture');

    const routableWithXai = getRoutableModelCapabilities(
      capabilities,
      new Set(['openai', 'anthropic', 'google', 'xai']),
    );
    expect(routableWithXai.map((model) => model.modelId)).toContain(
      'grok-test-fixture',
    );

    const decision = selectModelForSubtask(
      {
        id: 'st_new_provider',
        title: 'Draft a short response',
        objective: 'Write one short response.',
        kind: 'writing',
        requiredCapabilities: ['general_reasoning'],
        allowedTools: [],
        dependsOn: [],
        producesArtifact: true,
        risk: 'low',
      },
      routableWithXai,
      { enabledEndpointFamilies: ['chat'] },
    );

    const providerByModel = new Map(
      routableWithXai.map((model) => [model.modelId, model.providerId]),
    );
    const fallbackProviders = decision.fallbackModelIds.map((modelId) =>
      providerByModel.get(modelId),
    );
    const firstSameProviderFallback = fallbackProviders.findIndex(
      (providerId) => providerId === decision.providerId,
    );
    const newProviderFallback = decision.fallbackModelIds.indexOf(
      'grok-test-fixture',
    );

    expect(newProviderFallback).toBeGreaterThanOrEqual(0);
    expect(firstSameProviderFallback).toBeGreaterThan(newProviderFallback);
  });

  it('classifies generic new-provider rate limits and Retry-After values without provider-specific code', () => {
    const providerNames = buildProviderDisplayNameMap([provider('xai')]);
    const err = classifyProviderHttpError({
      providerId: 'xai',
      providerName: resolveProviderDisplayName('xai', providerNames),
      status: 429,
      retryAfterMs: parseRetryAfterMs('9'),
      body: '{"error":{"message":"masked prompt must not leak"}}',
    });

    expect(err.providerId).toBe('xai');
    expect(err.message).toBe('xAI API error: 429');
    expect(err.kind).toBe('rate_limit');
    expect(err.retryAfterMs).toBe(9_000);
    expect(err.message).not.toContain('masked prompt');
  });
});

function loadXaiFixture(): ProviderConfig[] {
  const registry = JSON.parse(readFileSync(providersWithXaiPath, 'utf8'));
  return registry.providers as ProviderConfig[];
}

function provider(
  id: string,
  displayName?: string | null,
): ProviderDisplayNameConfig {
  return {
    id,
    displayName,
  };
}
