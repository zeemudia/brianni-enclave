import {
  annotateNativeWebSearchError,
  getNativeWebSearchCapabilityRejectionReason,
  type NativeWebSearchCapability,
  type NativeWebSearchMode,
} from '@calypso/chat-types';
import { classifyProviderHttpError } from './errors';
export {
  getAnnotatedNativeWebSearchCapabilityRejectionReason,
  getAnnotatedNativeWebSearchFallbackReason,
  getNativeWebSearchCapabilityRejectionReason,
  getNativeWebSearchPreOutputFallbackReason,
} from '@calypso/chat-types';

export function effectiveNativeWebSearchMode({
  requested,
  capability,
  allowedByServer,
}: {
  requested?: NativeWebSearchMode;
  capability?: NativeWebSearchCapability;
  allowedByServer?: boolean;
}): NativeWebSearchMode {
  if (allowedByServer !== true) return 'off';
  if (requested !== 'auto') return 'off';
  return capability ? 'auto' : 'off';
}

export function isNativeWebSearchCapabilityRejection(
  providerId: string,
  err: unknown,
): boolean {
  return getNativeWebSearchCapabilityRejectionReason({
    providerId,
    error: err,
  }) !== null;
}

export function makeNativeWebSearchProviderError({
  providerId,
  providerName,
  status,
  providerBody,
  retryAfterMs,
}: {
  providerId: string;
  providerName: string;
  status: number;
  providerBody: string;
  retryAfterMs?: number;
}): Error {
  // providerBody is classification input only; annotateNativeWebSearchError
  // stores status/reason metadata, not the raw provider response text.
  const error = classifyProviderHttpError({
    providerId,
    providerName,
    status,
    body: providerBody,
    retryAfterMs,
  });
  return annotateNativeWebSearchError(error, {
    providerId,
    status,
    message: providerBody,
  });
}

export function makeNativeWebSearchProviderStreamError({
  providerId,
  providerName,
  providerBody,
}: {
  providerId: string;
  providerName: string;
  providerBody: string;
}): Error {
  // providerBody is classification input only; the thrown Error message stays
  // provider-body-free so route/enclave logs cannot echo provider payloads.
  return annotateNativeWebSearchError(new Error(`${providerName} API stream error`), {
    providerId,
    message: providerBody,
  });
}

export function logNativeWebSearchDowngrade({
  providerId,
  model,
  reason,
}: {
  providerId: string;
  model: string;
  reason: string;
}): void {
  console.warn(
    `[enclave] provider-native web search downgraded: provider=${providerId} model=${model} reason=${reason}`,
  );
}
