export type ProviderErrorKind =
  | 'rate_limit'
  | 'server'
  | 'transient'
  | 'auth'
  | 'invalid'
  | 'unknown';

// Bounds parsed provider retry hints; ProviderHealth applies a shorter
// circuit-breaker cap before skipping an entire provider in an orchestration run.
export const MAX_PROVIDER_RETRY_AFTER_MS = 3_600_000;

const SAFE_STRING_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
  'RESOURCE_EXHAUSTED',
  'OVERLOADED_ERROR',
  'RATE_LIMIT',
  'RATE_LIMIT_EXCEEDED',
  'INSUFFICIENT_QUOTA',
]);

export class ProviderError extends Error {
  readonly providerId!: string;
  readonly status?: number;
  readonly kind!: ProviderErrorKind;
  readonly retryAfterMs?: number;
  declare readonly cause?: unknown;

  constructor(input: {
    providerId: string;
    providerName: string;
    status?: number;
    kind: ProviderErrorKind;
    retryAfterMs?: number;
    cause?: unknown;
  }) {
    super(`${input.providerName} API error: ${input.status ?? input.kind}`);
    const retryAfterMs = normaliseRetryAfterMs(input.retryAfterMs);
    const cause = sanitiseProviderCause(input.cause);
    const properties: PropertyDescriptorMap = {
      name: {
        value: 'ProviderError',
        enumerable: false,
        writable: false,
        configurable: false,
      },
      providerId: {
        value: input.providerId,
        enumerable: false,
        writable: false,
        configurable: false,
      },
      status: {
        value: input.status,
        enumerable: false,
        writable: false,
        configurable: false,
      },
      kind: {
        value: input.kind,
        enumerable: false,
        writable: false,
        configurable: false,
      },
      retryAfterMs: {
        value: retryAfterMs,
        enumerable: false,
        writable: false,
        configurable: false,
      },
    };
    if (cause !== undefined) {
      properties.cause = {
        value: cause,
        enumerable: false,
        writable: false,
        configurable: false,
      };
    }
    Object.defineProperties(this, properties);
  }
}

class ProviderErrorCause extends Error {
  readonly originalName?: string;
  readonly code?: string | number;
  readonly status?: number;

  constructor(error: unknown) {
    const metadata = providerCauseMetadata(error);
    const suffix = formatProviderCauseSuffix(metadata);
    super(`provider error cause redacted${suffix}`);
    Object.defineProperty(this, 'name', {
      value: 'ProviderErrorCause',
      enumerable: false,
      writable: false,
      configurable: false,
    });
    Object.defineProperties(this, {
      originalName: {
        value: metadata.originalName,
        enumerable: false,
        writable: false,
        configurable: false,
      },
      code: {
        value: metadata.code,
        enumerable: false,
        writable: false,
        configurable: false,
      },
      status: {
        value: metadata.status,
        enumerable: false,
        writable: false,
        configurable: false,
      },
    });
  }
}

export function providerErrorFromUnknown(error: unknown): ProviderError | null {
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 5; depth += 1) {
    if (current instanceof ProviderError) return current;
    if (!current || typeof current !== 'object' || seen.has(current)) {
      return null;
    }
    seen.add(current);
    try {
      current = (current as { cause?: unknown }).cause;
    } catch {
      return null;
    }
  }
  return current instanceof ProviderError ? current : null;
}

export function parseRetryAfterMs(
  value: string | null | undefined,
  nowMs: () => number = () => Date.now(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return normaliseRetryAfterMs(Number(trimmed) * 1_000);
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  return normaliseRetryAfterMs(parsed - nowMs());
}

function normaliseRetryAfterMs(value: number | undefined): number | undefined {
  if (value === undefined || Number.isNaN(value)) return undefined;
  if (value <= 0) return 0;
  if (!Number.isFinite(value)) return MAX_PROVIDER_RETRY_AFTER_MS;
  return clampRetryAfterMs(value);
}

function clampRetryAfterMs(value: number): number {
  if (value <= MAX_PROVIDER_RETRY_AFTER_MS) return value;
  return MAX_PROVIDER_RETRY_AFTER_MS;
}

export function classifyProviderHttpError(input: {
  providerId: string;
  providerName: string;
  status: number;
  body?: string;
  retryAfterMs?: number;
}): ProviderError {
  return new ProviderError({
    providerId: input.providerId,
    providerName: input.providerName,
    status: input.status,
    kind: classifyStatusAndBody(input.status, input.body ?? ''),
    retryAfterMs: input.retryAfterMs,
  });
}

/**
 * H2: classify a mid-stream SSE error EVENT (Anthropic `{"type":"error"}`,
 * OpenAI chat-completions `{"error":{...}}`). Only the provider's
 * machine-readable type/code tokens are consulted for classification; the
 * resulting ProviderError carries the standard fixed-format message, so
 * nothing payload-derived can ride along into logs or wire frames.
 */
export function classifyProviderStreamError(input: {
  providerId: string;
  providerName: string;
  errorType?: unknown;
  errorCode?: unknown;
}): ProviderError {
  const tokens = [input.errorCode, input.errorType]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  return new ProviderError({
    providerId: input.providerId,
    providerName: input.providerName,
    kind: classifyMessage(tokens),
  });
}

export function normaliseProviderError(
  error: unknown,
  providerId: string,
  providerName: string,
): ProviderError {
  const providerError = providerErrorFromUnknown(error);
  if (providerError) return providerError;
  const status = statusFromError(error);
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  return new ProviderError({
    providerId,
    providerName,
    status,
    kind:
      status !== undefined
        ? classifyStatusAndBody(status, message)
        : classifyMessage(message),
    cause: error,
  });
}

function sanitiseProviderCause(error: unknown): Error | undefined {
  if (error === undefined || error === null) return undefined;
  return new ProviderErrorCause(error);
}

type ProviderCauseMetadata = {
  originalName?: string;
  code?: string | number;
  status?: number;
};

function providerCauseMetadata(error: unknown): ProviderCauseMetadata {
  try {
    return providerCauseMetadataUnsafe(error);
  } catch {
    return {};
  }
}

function providerCauseMetadataUnsafe(error: unknown): ProviderCauseMetadata {
  if (!error || typeof error !== 'object') return {};
  const maybe = error as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
  };
  return {
    originalName: safeErrorConstructorName(error),
    code: safeProviderCode(maybe.code),
    status: isHttpStatus(maybe.status)
      ? maybe.status
      : isHttpStatus(maybe.statusCode)
        ? maybe.statusCode
        : undefined,
  };
}

function safeErrorConstructorName(error: object): string | undefined {
  const constructorName = error.constructor?.name;
  return safeIdentifier(constructorName) ? constructorName : undefined;
}

function safeIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(value)
  );
}

function safeProviderCode(code: unknown): string | number | undefined {
  if (typeof code === 'number' && Number.isInteger(code) && code >= 0) {
    return code <= 599 ? code : undefined;
  }
  if (typeof code !== 'string') return undefined;
  const normalized = code.trim().toUpperCase();
  return SAFE_STRING_ERROR_CODES.has(normalized) ? normalized : undefined;
}

function formatProviderCauseSuffix(metadata: ProviderCauseMetadata): string {
  const details: string[] = [];
  if (metadata.originalName) details.push(`name=${metadata.originalName}`);
  if (metadata.code !== undefined) details.push(`code=${metadata.code}`);
  if (metadata.status !== undefined) details.push(`status=${metadata.status}`);
  return details.length > 0 ? ` (${details.join(' ')})` : '';
}

function classifyStatusAndBody(
  status: number,
  body: string,
): ProviderErrorKind {
  const lower = body.toLowerCase();
  if (
    status === 429 ||
    lower.includes('rate_limit') ||
    lower.includes('resource_exhausted') ||
    lower.includes('overloaded_error')
  ) {
    return 'rate_limit';
  }
  if (status === 529) return 'rate_limit';
  if (status === 401 || status === 403) return 'auth';
  if (status === 408 || status === 425) return 'transient';
  if (status >= 500) return 'server';
  if (status >= 400) return 'invalid';
  return classifyMessageWithoutStatus(body);
}

function classifyMessage(message: string): ProviderErrorKind {
  const direct = classifyMessageWithoutStatus(message);
  if (direct !== 'unknown') return direct;
  const status = statusFromMessage(message);
  return status !== undefined && status >= 400
    ? classifyStatusAndBody(status, '')
    : 'unknown';
}

function classifyMessageWithoutStatus(message: string): ProviderErrorKind {
  const lower = message.toLowerCase();
  if (
    hasNumericToken(lower, '429') ||
    lower.includes('rate_limit') ||
    lower.includes('rate limit') ||
    lower.includes('resource_exhausted') ||
    lower.includes('overloaded_error')
  ) {
    return 'rate_limit';
  }
  if (hasNumericToken(lower, '401') || hasNumericToken(lower, '403')) {
    return 'auth';
  }
  if (
    lower.includes('fetch failed') ||
    lower.includes('network') ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('econnreset') ||
    lower.includes('socket hang up')
  ) {
    return 'transient';
  }
  return 'unknown';
}

function hasNumericToken(value: string, token: string): boolean {
  return new RegExp(`(^|[^0-9])${token}([^0-9]|$)`).test(value);
}

function statusFromError(error: unknown): number | undefined {
  try {
    return statusFromErrorUnsafe(error);
  } catch {
    return undefined;
  }
}

function statusFromErrorUnsafe(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const maybe = error as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    message?: unknown;
  };
  if (isHttpStatus(maybe.status)) {
    return maybe.status;
  }
  if (isHttpStatus(maybe.statusCode)) {
    return maybe.statusCode;
  }
  if (isHttpStatus(maybe.code)) {
    return maybe.code;
  }
  return typeof maybe.message === 'string'
    ? statusFromMessage(maybe.message)
    : undefined;
}

function isHttpStatus(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
  );
}

function statusFromMessage(message: string): number | undefined {
  const match = message.match(/\b([1-5]\d\d)\b/);
  return match ? Number(match[1]) : undefined;
}
