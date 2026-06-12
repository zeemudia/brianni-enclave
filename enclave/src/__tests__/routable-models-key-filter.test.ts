import { describe, expect, it } from 'vitest';
import type { ModelCapability } from '@calypso/chat-types';

import { getRoutableModelCapabilities } from '../index';

function mk(modelId: string, providerId: string): ModelCapability {
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

describe('getRoutableModelCapabilities — provider-key availability', () => {
  const models = [mk('gpt', 'openai'), mk('claude', 'anthropic'), mk('gemini', 'google')];

  // Regression: the router selects from the routable catalog and has no
  // visibility into which provider keys are present. If a model whose
  // provider key is absent stays routable, the router can pick it and the
  // subtask then dies mid-execution with PROVIDER_KEY_MISSING. A keyless
  // provider's models must never reach the router.
  it('excludes models whose provider has no key', () => {
    const out = getRoutableModelCapabilities(
      models,
      new Set(['openai', 'anthropic']),
    );
    expect(out.map((m) => m.modelId).sort()).toEqual(['claude', 'gpt']);
  });

  it('returns all enabled models when the key set is omitted (back-compat)', () => {
    const out = getRoutableModelCapabilities(models);
    expect(out.map((m) => m.modelId).sort()).toEqual(['claude', 'gemini', 'gpt']);
  });
});
