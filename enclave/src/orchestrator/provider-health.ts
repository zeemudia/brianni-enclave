import type { ModelCapability, ModelRouteDecision } from '@calypso/chat-types';

import { ProviderError } from '../providers/errors';

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const MIN_COOLDOWN_MS = 1_000;
// Keep the per-run circuit breaker availability-biased even when a provider
// sends a longer Retry-After hint.
export const MAX_PROVIDER_COOLDOWN_MS = 300_000;

export class ProviderHealth {
  private readonly cooldownUntilMs = new Map<string, number>();

  mark(error: ProviderError, nowMs: number): void {
    if (error.kind !== 'rate_limit') return;
    const duration = error.retryAfterMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS;
    const clamped = Math.min(
      Math.max(duration, MIN_COOLDOWN_MS),
      MAX_PROVIDER_COOLDOWN_MS,
    );
    const current = this.cooldownUntilMs.get(error.providerId) ?? 0;
    this.cooldownUntilMs.set(
      error.providerId,
      Math.max(current, nowMs + clamped),
    );
  }

  isCooling(providerId: string, nowMs: number): boolean {
    return (this.cooldownUntilMs.get(providerId) ?? 0) > nowMs;
  }
}

export function buildAttemptModelIds(
  route: ModelRouteDecision,
  models: readonly ModelCapability[],
  health: ProviderHealth,
  nowMs: number,
  maxAttempts: number,
  attemptedModelIds: ReadonlySet<string> = new Set(),
): string[] {
  const providerByModel = new Map(
    models.map((model) => [model.modelId, model.providerId]),
  );
  const unique = [...new Set([route.modelId, ...route.fallbackModelIds])];
  const known = unique.filter(
    (modelId) =>
      providerByModel.has(modelId) && !attemptedModelIds.has(modelId),
  );
  const active = known.filter(
    (modelId) => !health.isCooling(providerByModel.get(modelId)!, nowMs),
  );
  const cooling = known.filter((modelId) =>
    health.isCooling(providerByModel.get(modelId)!, nowMs),
  );
  const ordered = active.length > 0 ? [...active, ...cooling] : known;
  return ordered.slice(0, maxAttempts);
}
