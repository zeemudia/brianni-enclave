import { describe, expect, it } from 'vitest';
import type { ModelCapability } from '@calypso/chat-types';

import { admitAgentModel } from '../index';

function model(modelId: string, costTier: ModelCapability['costTier']): ModelCapability {
  return {
    modelId,
    providerId: 'anthropic',
    strengths: ['general_reasoning'],
    strengthQuality: [],
    modalities: ['text_in', 'text_out'],
    endpointFamily: 'chat',
    costTier,
    latencyTier: 'standard',
    routingStatus: 'enabled',
    requiredGatewayTools: [],
    maxContextTokens: 200000,
  };
}

const CHAT_MODELS: ModelCapability[] = [
  model('gpt-5.5', 'high'),
  model('claude-haiku-4-5', 'low'),
  model('gpt-5.4-mini', 'low'),
];

describe('admitAgentModel (enclave-authoritative agent model admission)', () => {
  it('FREE + auto -> an approved low-cost chat model (prefers haiku)', () => {
    const r = admitAgentModel('auto', 'FREE', CHAT_MODELS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.modelId).toBe('claude-haiku-4-5');
  });

  it('FREE + empty model -> low-cost default (treated as auto)', () => {
    const r = admitAgentModel('', 'FREE', CHAT_MODELS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(CHAT_MODELS.find((m) => m.modelId === r.modelId)?.costTier).toBe('low');
  });

  it('FREE + a concrete low-cost model passes through', () => {
    const r = admitAgentModel('gpt-5.4-mini', 'FREE', CHAT_MODELS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.modelId).toBe('gpt-5.4-mini');
  });

  it('FREE + a concrete HIGH-cost model is REJECTED', () => {
    const r = admitAgentModel('gpt-5.5', 'FREE', CHAT_MODELS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('FREE_AGENT_MODEL_NOT_ALLOWED');
  });

  it('FREE + an unknown model is REJECTED (not in the low-cost catalog)', () => {
    const r = admitAgentModel('totally-made-up', 'FREE', CHAT_MODELS);
    expect(r.ok).toBe(false);
  });

  it('PRO + auto -> a routable chat model (no cost gate)', () => {
    const r = admitAgentModel('auto', 'PRO', CHAT_MODELS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.modelId).toBe('gpt-5.5');
  });

  it('PRO/MAX + a concrete high-cost model passes through', () => {
    expect(admitAgentModel('gpt-5.5', 'PRO', CHAT_MODELS)).toEqual({
      ok: true,
      modelId: 'gpt-5.5',
    });
    expect(admitAgentModel('gpt-5.5', 'MAX', CHAT_MODELS)).toEqual({
      ok: true,
      modelId: 'gpt-5.5',
    });
  });

  it('FREE + auto with no low-cost model available fails closed', () => {
    const r = admitAgentModel('auto', 'FREE', [model('gpt-5.5', 'high')]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('AGENT_NO_LOW_COST_MODEL');
  });
});
