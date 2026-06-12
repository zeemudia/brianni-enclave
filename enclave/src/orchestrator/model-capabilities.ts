import {
  ModelCapabilitySchema,
  type ModelCapability,
} from '@calypso/chat-types';

import type { ProviderConfig } from '../providers/registry';

export function buildModelCapabilities(
  providers: ProviderConfig[],
): ModelCapability[] {
  return providers.flatMap((provider) =>
    provider.models.map((model) =>
      ModelCapabilitySchema.parse({
        modelId: model.id,
        providerId: provider.id,
        strengths: model.capabilities?.strengths ?? ['general_reasoning'],
        strengthQuality: model.capabilities?.strengthQuality ?? [],
        modalities: model.capabilities?.modalities ?? ['text_in', 'text_out'],
        endpointFamily: model.capabilities?.endpointFamily ?? 'chat',
        costTier: model.capabilities?.costTier ?? 'medium',
        latencyTier: model.capabilities?.latencyTier ?? 'standard',
        routingStatus: model.capabilities?.routingStatus ?? 'enabled',
        requiredGatewayTools: model.capabilities?.requiredGatewayTools ?? [],
        nativeWebSearch: model.capabilities?.nativeWebSearch,
        maxContextTokens: model.contextWindow,
      }),
    ),
  );
}
