import type { ChatMessage } from '@calypso/chat-types';

export type PromptCacheMode =
  | 'anthropic_ephemeral'
  | 'openai_automatic_only'
  | 'gemini_implicit_only'
  | 'disabled';

export interface PromptCachePlan {
  providerId: string;
  model: string;
  mode: PromptCacheMode;
  eligibleForProviderWrite: boolean;
  minCacheableInputTokens?: number;
  estimatedInputTokens?: number;
  reason?: string;
}

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface AnthropicApiMessage {
  role: Exclude<ChatMessage['role'], 'system'>;
  content: unknown;
}

export interface AnthropicPromptCacheRequest {
  plan: PromptCachePlan;
  system?: string | AnthropicTextBlock[];
  messages: AnthropicApiMessage[];
  cacheBreakpoints: Array<
    | { location: 'system' }
    | { location: 'message'; index: number }
  >;
}

const MAX_ANTHROPIC_CACHE_BREAKPOINTS = 4;
const ANTHROPIC_INTERMEDIATE_BREAKPOINT_INTERVAL = 15;
const APPROX_CHARS_PER_TOKEN = 4;

const ANTHROPIC_CACHE_MIN_TOKENS: Array<{
  pattern: RegExp;
  minTokens: number;
}> = [
  { pattern: /^claude-opus-4-[5-8](?:-|$)/, minTokens: 4_096 },
  { pattern: /^claude-sonnet-4-6(?:-|$)/, minTokens: 2_048 },
  { pattern: /^claude-haiku-4-5(?:-|$)/, minTokens: 4_096 },
  { pattern: /^claude-sonnet-4-[015](?:-|$)/, minTokens: 1_024 },
  { pattern: /^claude-3-7-sonnet(?:-|$)/, minTokens: 1_024 },
];

const OPENAI_EXTENDED_RETENTION_CACHE_MODELS = new Set([
  'gpt-5.5',
  'gpt-5.5-pro',
]);

export function planProviderPromptCaching(input: {
  providerId: string;
  model: string;
  estimatedInputTokens?: number;
}): PromptCachePlan {
  if (input.providerId === 'anthropic') {
    const minCacheableInputTokens = minAnthropicCacheTokens(input.model);
    const estimatedInputTokens = input.estimatedInputTokens ?? 0;
    return {
      providerId: input.providerId,
      model: input.model,
      mode: 'anthropic_ephemeral',
      eligibleForProviderWrite: estimatedInputTokens >= minCacheableInputTokens,
      minCacheableInputTokens,
      estimatedInputTokens,
      reason:
        estimatedInputTokens >= minCacheableInputTokens
          ? undefined
          : 'prefix_below_threshold',
    };
  }

  if (input.providerId === 'openai') {
    return {
      providerId: input.providerId,
      model: input.model,
      mode: 'openai_automatic_only',
      eligibleForProviderWrite: false,
      estimatedInputTokens: input.estimatedInputTokens,
      reason: OPENAI_EXTENDED_RETENTION_CACHE_MODELS.has(input.model)
        ? 'extended_retention_requires_privacy_review'
        : 'automatic_provider_caching_only',
    };
  }

  if (input.providerId === 'google') {
    return {
      providerId: input.providerId,
      model: input.model,
      mode: 'gemini_implicit_only',
      eligibleForProviderWrite: false,
      estimatedInputTokens: input.estimatedInputTokens,
      reason: 'explicit_cache_disabled_for_private_content',
    };
  }

  return {
    providerId: input.providerId,
    model: input.model,
    mode: 'disabled',
    eligibleForProviderWrite: false,
    estimatedInputTokens: input.estimatedInputTokens,
    reason: 'provider_not_supported',
  };
}

export function buildAnthropicPromptCacheRequest(input: {
  model: string;
  system?: string;
  messages: ChatMessage[];
  estimatedInputTokens?: number;
}): AnthropicPromptCacheRequest {
  const estimatedInputTokens =
    input.estimatedInputTokens ??
    estimatePromptTokens([
      input.system ?? '',
      ...input.messages.map((message) =>
        typeof message.content === 'string' ? message.content : '',
      ),
    ]);
  const plan = planProviderPromptCaching({
    providerId: 'anthropic',
    model: input.model,
    estimatedInputTokens,
  });
  const messages = input.messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role as Exclude<ChatMessage['role'], 'system'>,
      content: message.content,
    }));

  if (!plan.eligibleForProviderWrite) {
    return {
      plan,
      system: input.system,
      messages,
      cacheBreakpoints: [],
    };
  }

  const cacheBreakpoints: AnthropicPromptCacheRequest['cacheBreakpoints'] = [];
  let remainingBreakpoints = MAX_ANTHROPIC_CACHE_BREAKPOINTS;
  let system: AnthropicPromptCacheRequest['system'] = input.system;
  if (input.system?.trim()) {
    system = [cacheableTextBlock(input.system)];
    cacheBreakpoints.push({ location: 'system' });
    remainingBreakpoints -= 1;
  }

  const messageBreakpointIndexes = chooseAnthropicMessageBreakpointIndexes(
    messages,
    remainingBreakpoints,
  );
  const breakpointIndexSet = new Set(messageBreakpointIndexes);
  const decoratedMessages = messages.map((message, index) => {
    if (!breakpointIndexSet.has(index)) return message;
    if (typeof message.content !== 'string') return message;
    cacheBreakpoints.push({ location: 'message', index });
    return {
      ...message,
      content: [cacheableTextBlock(message.content)],
    };
  });

  return {
    plan,
    system,
    messages: decoratedMessages,
    cacheBreakpoints,
  };
}

export function buildOpenAIPrivatePromptCacheOptions(input: {
  model: string;
  estimatedInputTokens?: number;
}): { requestOptions: Record<string, never>; plan: PromptCachePlan } {
  return {
    requestOptions: {},
    plan: planProviderPromptCaching({
      providerId: 'openai',
      model: input.model,
      estimatedInputTokens: input.estimatedInputTokens,
    }),
  };
}

export function buildGeminiPrivatePromptCacheOptions(input: {
  model: string;
  estimatedInputTokens?: number;
}): { requestOptions: Record<string, never>; plan: PromptCachePlan } {
  return {
    requestOptions: {},
    plan: planProviderPromptCaching({
      providerId: 'google',
      model: input.model,
      estimatedInputTokens: input.estimatedInputTokens,
    }),
  };
}

export function estimatePromptTokens(texts: readonly string[]): number {
  const chars = texts.reduce((total, text) => total + text.length, 0);
  return Math.ceil(chars / APPROX_CHARS_PER_TOKEN);
}

function minAnthropicCacheTokens(model: string): number {
  return (
    ANTHROPIC_CACHE_MIN_TOKENS.find(({ pattern }) => pattern.test(model))
      ?.minTokens ?? 1_024
  );
}

function cacheableTextBlock(text: string): AnthropicTextBlock {
  return {
    type: 'text',
    text,
    cache_control: { type: 'ephemeral' },
  };
}

function chooseAnthropicMessageBreakpointIndexes(
  messages: readonly AnthropicApiMessage[],
  maxBreakpoints: number,
): number[] {
  if (messages.length <= 0 || maxBreakpoints <= 0) return [];
  const eligibleIndexes = messages.flatMap((message, index) =>
    typeof message.content === 'string' && message.content.trim() ? [index] : [],
  );
  if (eligibleIndexes.length === 0) return [];

  const indexes: number[] = [];
  for (
    let eligibleOrdinal = ANTHROPIC_INTERMEDIATE_BREAKPOINT_INTERVAL - 1;
    eligibleOrdinal < eligibleIndexes.length;
    eligibleOrdinal += ANTHROPIC_INTERMEDIATE_BREAKPOINT_INTERVAL
  ) {
    indexes.push(eligibleIndexes[eligibleOrdinal]);
  }

  const lastIndex = eligibleIndexes[eligibleIndexes.length - 1];
  if (!indexes.includes(lastIndex)) indexes.push(lastIndex);
  if (indexes.length <= maxBreakpoints) return indexes;

  const keepLast = indexes[indexes.length - 1];
  const trimmed = indexes.slice(0, Math.max(maxBreakpoints - 1, 0));
  if (trimmed.length < maxBreakpoints && keepLast !== undefined) {
    trimmed.push(keepLast);
  }
  return trimmed;
}
