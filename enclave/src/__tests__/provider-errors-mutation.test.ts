import { describe, expect, it } from 'vitest';

import {
  MAX_PROVIDER_RETRY_AFTER_MS,
  ProviderError,
  classifyProviderHttpError,
  normaliseProviderError,
  parseRetryAfterMs,
} from '../providers/errors';

/*
 * Mutation-hardening supplement for providers/errors.ts. The existing
 * provider-errors.test.ts covers the headline cases; this file pins the
 * remaining BEHAVIOR-BEARING boundaries that drive retry / fallback / auth
 * trust and the host-observable cause sanitiser:
 *   - each SAFE_STRING_ERROR_CODES member is actually recognised (deleting one
 *     would silently drop a real network/quota code from the redacted cause),
 *   - the safeProviderCode numeric-code bounds (0..599 integer),
 *   - the isHttpStatus range boundaries (100..599),
 *   - the status-classification thresholds used by fallback routing,
 *   - retry-after clamp boundaries.
 */

function causeOf(err: ProviderError): {
  code?: unknown;
  status?: unknown;
  originalName?: unknown;
  message?: string;
} {
  return err.cause as never;
}

describe('SAFE_STRING_ERROR_CODES — each member is recognised by safeProviderCode', () => {
  const SAFE_CODES = [
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
  ];

  it.each(SAFE_CODES)('keeps the safe error code %s on the redacted cause', (code) => {
    const original = Object.assign(new Error('provider failure'), { code });
    const err = normaliseProviderError(original, 'openai', 'OpenAI');
    expect(causeOf(err).code).toBe(code);
    expect(causeOf(err).message).toContain(`code=${code}`);
  });

  it('normalises lowercase + surrounding whitespace before the allow-list check', () => {
    const original = Object.assign(new Error('x'), { code: '  econnreset  ' });
    const err = normaliseProviderError(original, 'openai', 'OpenAI');
    expect(causeOf(err).code).toBe('ECONNRESET');
  });

  it('drops a string code that is NOT in the allow-list', () => {
    const original = Object.assign(new Error('x'), { code: 'ENOTASAFECODE' });
    const err = normaliseProviderError(original, 'openai', 'OpenAI');
    expect(causeOf(err).code).toBeUndefined();
  });
});

describe('safeProviderCode numeric-code bounds (0..599 integer)', () => {
  it('keeps an in-range integer code (599 boundary inclusive)', () => {
    const err = normaliseProviderError(
      Object.assign(new Error('x'), { code: 599 }),
      'openai',
      'OpenAI',
    );
    // 599 is not an HTTP status used by isHttpStatus for `status` field here
    // (statusFromError reads .status/.statusCode/.code), but safeProviderCode
    // keeps 0..599 integers as the redacted cause `code`.
    expect(causeOf(err).code).toBe(599);
  });

  it('drops a numeric code above the 599 ceiling', () => {
    const err = normaliseProviderError(
      Object.assign(new Error('x'), { code: 600 }),
      'openai',
      'OpenAI',
    );
    expect(causeOf(err).code).toBeUndefined();
  });

  it('keeps a zero code (>= 0 boundary inclusive)', () => {
    const err = normaliseProviderError(
      Object.assign(new Error('x'), { code: 0 }),
      'openai',
      'OpenAI',
    );
    expect(causeOf(err).code).toBe(0);
  });

  it('drops a negative numeric code', () => {
    const err = normaliseProviderError(
      Object.assign(new Error('x'), { code: -1 }),
      'openai',
      'OpenAI',
    );
    expect(causeOf(err).code).toBeUndefined();
  });

  it('drops a non-integer numeric code', () => {
    const err = normaliseProviderError(
      Object.assign(new Error('x'), { code: 4.5 }),
      'openai',
      'OpenAI',
    );
    expect(causeOf(err).code).toBeUndefined();
  });
});

describe('isHttpStatus range (100..599) drives the parsed status', () => {
  it('accepts the lower boundary 100', () => {
    const err = normaliseProviderError(
      Object.assign(new Error('x'), { status: 100 }),
      'openai',
      'OpenAI',
    );
    expect(err.status).toBe(100);
  });

  it('rejects 99 (below the 100 floor)', () => {
    const err = normaliseProviderError(
      Object.assign(new Error('x'), { status: 99 }),
      'openai',
      'OpenAI',
    );
    expect(err.status).toBeUndefined();
  });

  it('accepts the upper boundary 599', () => {
    const err = normaliseProviderError(
      Object.assign(new Error('x'), { status: 599 }),
      'openai',
      'OpenAI',
    );
    expect(err.status).toBe(599);
  });

  it('rejects 600 (above the 599 ceiling)', () => {
    const err = normaliseProviderError(
      Object.assign(new Error('x'), { status: 600 }),
      'openai',
      'OpenAI',
    );
    expect(err.status).toBeUndefined();
  });

  it('rejects a non-integer status', () => {
    const err = normaliseProviderError(
      Object.assign(new Error('x'), { status: 429.5 }),
      'openai',
      'OpenAI',
    );
    expect(err.status).toBeUndefined();
  });
});

describe('status classification thresholds used by fallback routing', () => {
  it('classifies exactly 529 as rate_limit (Anthropic overload)', () => {
    expect(
      classifyProviderHttpError({ providerId: 'a', providerName: 'A', status: 529 }).kind,
    ).toBe('rate_limit');
  });

  it('classifies 528 (just below the 529 special-case) as server', () => {
    expect(
      classifyProviderHttpError({ providerId: 'a', providerName: 'A', status: 528 }).kind,
    ).toBe('server');
  });

  it('classifies exactly 500 as server (>= 500 boundary)', () => {
    expect(
      classifyProviderHttpError({ providerId: 'a', providerName: 'A', status: 500 }).kind,
    ).toBe('server');
  });

  it('classifies 400 as invalid (>= 400 boundary, below 500)', () => {
    expect(
      classifyProviderHttpError({ providerId: 'a', providerName: 'A', status: 400 }).kind,
    ).toBe('invalid');
  });

  it('classifies a 3xx with no body token as unknown (below the 400 floor)', () => {
    expect(
      classifyProviderHttpError({ providerId: 'a', providerName: 'A', status: 302 }).kind,
    ).toBe('unknown');
  });

  it('classifies 408 and 425 as transient (not invalid)', () => {
    expect(
      classifyProviderHttpError({ providerId: 'a', providerName: 'A', status: 408 }).kind,
    ).toBe('transient');
    expect(
      classifyProviderHttpError({ providerId: 'a', providerName: 'A', status: 425 }).kind,
    ).toBe('transient');
  });

  it('classifies a 401-token message (no status) as auth', () => {
    expect(normaliseProviderError(new Error('HTTP 401 Unauthorized'), 'a', 'A').kind).toBe(
      'auth',
    );
    expect(normaliseProviderError(new Error('got a 403 back'), 'a', 'A').kind).toBe('auth');
  });
});

describe('retry-after clamp boundaries', () => {
  it('keeps a value exactly at MAX_PROVIDER_RETRY_AFTER_MS (<= boundary)', () => {
    const seconds = MAX_PROVIDER_RETRY_AFTER_MS / 1000;
    expect(parseRetryAfterMs(String(seconds), () => 0)).toBe(MAX_PROVIDER_RETRY_AFTER_MS);
  });

  it('clamps one second above the max down to the max', () => {
    const seconds = MAX_PROVIDER_RETRY_AFTER_MS / 1000 + 1;
    expect(parseRetryAfterMs(String(seconds), () => 0)).toBe(MAX_PROVIDER_RETRY_AFTER_MS);
  });

  it('floors a negative computed retry-after to 0 (<= 0 boundary)', () => {
    // HTTP-date strictly in the past ⇒ negative delta ⇒ 0, not undefined.
    const now = Date.parse('2026-06-06T10:00:00.000Z');
    expect(
      parseRetryAfterMs('Sat, 06 Jun 2026 09:00:00 GMT', () => now),
    ).toBe(0);
  });

  it('treats a zero-seconds retry-after as 0 (boundary, not undefined)', () => {
    expect(parseRetryAfterMs('0', () => 1000)).toBe(0);
  });
});

describe('safeIdentifier guards the redacted cause constructor name', () => {
  class WeirdName$ extends Error {}

  it('keeps a safe constructor name on the cause', () => {
    const err = normaliseProviderError(new TypeError('boom'), 'a', 'A');
    expect(causeOf(err).originalName).toBe('TypeError');
    expect(causeOf(err).message).toContain('name=TypeError');
  });

  it('drops a constructor name containing characters outside the safe identifier set', () => {
    const original = new WeirdName$('boom');
    const err = normaliseProviderError(original, 'a', 'A');
    // `WeirdName$` contains `$`, which is outside /^[A-Za-z][A-Za-z0-9_.:-]*$/.
    expect(causeOf(err).originalName).toBeUndefined();
    expect(causeOf(err).message ?? '').not.toContain('name=');
  });
});
