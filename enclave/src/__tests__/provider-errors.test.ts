import { describe, expect, it } from 'vitest';
import { inspect } from 'node:util';

import {
  ProviderError,
  MAX_PROVIDER_RETRY_AFTER_MS,
  classifyProviderHttpError,
  normaliseProviderError,
  parseRetryAfterMs,
  providerErrorFromUnknown,
} from '../providers/errors';

describe('provider error classification', () => {
  it('classifies provider rate limits without leaking response bodies', () => {
    const err = classifyProviderHttpError({
      providerId: 'openai',
      providerName: 'OpenAI',
      status: 429,
      body: '{"error":{"message":"masked user text should not leak","type":"rate_limit"}}',
    });

    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe('rate_limit');
    expect(err.providerId).toBe('openai');
    expect(err.status).toBe(429);
    expect(err.message).toBe('OpenAI API error: 429');
    expect(err.message).not.toContain('masked user text');
  });

  it('treats Anthropic overload as provider cooldown input', () => {
    const err = classifyProviderHttpError({
      providerId: 'anthropic',
      providerName: 'Anthropic',
      status: 529,
      body: '{"type":"overloaded_error"}',
    });

    expect(err.kind).toBe('rate_limit');
    expect(err.status).toBe(529);
  });

  it('treats Google RESOURCE_EXHAUSTED as a rate limit', () => {
    const err = classifyProviderHttpError({
      providerId: 'google',
      providerName: 'Google',
      status: 400,
      body: '{"error":{"status":"RESOURCE_EXHAUSTED"}}',
    });

    expect(err.kind).toBe('rate_limit');
  });

  it('parses Retry-After seconds and HTTP-date values', () => {
    expect(parseRetryAfterMs('3', () => 1_000)).toBe(3_000);
    const now = Date.parse('2026-06-06T10:00:00.000Z');
    expect(parseRetryAfterMs('Sat, 06 Jun 2026 10:00:05 GMT', () => now)).toBe(
      5_000,
    );
  });

  it('clamps untrusted Retry-After values to the provider cooldown maximum', () => {
    expect(parseRetryAfterMs('99999999', () => 1_000)).toBe(
      MAX_PROVIDER_RETRY_AFTER_MS,
    );
    const now = Date.parse('2026-06-06T10:00:00.000Z');
    expect(parseRetryAfterMs('Sun, 07 Jun 2026 10:00:00 GMT', () => now)).toBe(
      MAX_PROVIDER_RETRY_AFTER_MS,
    );
  });

  it('normalises direct ProviderError retry hints before storing them', () => {
    const huge = new ProviderError({
      providerId: 'openai',
      providerName: 'OpenAI',
      status: 429,
      kind: 'rate_limit',
      retryAfterMs: Number.POSITIVE_INFINITY,
    });
    const negative = new ProviderError({
      providerId: 'openai',
      providerName: 'OpenAI',
      status: 429,
      kind: 'rate_limit',
      retryAfterMs: -10_000,
    });
    const invalid = new ProviderError({
      providerId: 'openai',
      providerName: 'OpenAI',
      status: 429,
      kind: 'rate_limit',
      retryAfterMs: Number.NaN,
    });

    expect(huge.retryAfterMs).toBe(MAX_PROVIDER_RETRY_AFTER_MS);
    expect(negative.retryAfterMs).toBe(0);
    expect(invalid.retryAfterMs).toBeUndefined();
  });

  it('normalises legacy bare provider errors by status in the message', () => {
    const original = new Error('OpenAI API error: 429');
    const err = normaliseProviderError(original, 'openai', 'OpenAI');

    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe('rate_limit');
    expect(err.status).toBe(429);
    expect(err.cause).not.toBe(original);
    expect(err.cause).toBeInstanceOf(Error);
  });

  it('sanitizes direct ProviderError causes before loggers can inspect them', () => {
    const err = new ProviderError({
      providerId: 'openai',
      providerName: 'OpenAI',
      status: 429,
      kind: 'rate_limit',
      cause: new Error('FAKE_PROVIDER_SECRET in upstream stack'),
    });
    const inspected = inspect(err, { depth: 5 });

    expect(err.cause).toBeInstanceOf(Error);
    expect(err.cause).not.toBeInstanceOf(ProviderError);
    expect(inspected).not.toContain('FAKE_PROVIDER_SECRET');
    expect(inspected).toContain('ProviderErrorCause');
  });

  it('sanitizes ProviderError cause chains before loggers can inspect them', () => {
    const original = Object.assign(
      new Error('provider body contained FAKE_PROVIDER_SECRET'),
      {
        response: {
          body: 'masked user text and FAKE_PROVIDER_SECRET',
          headers: { Authorization: 'Bearer FAKE_PROVIDER_SECRET' },
        },
        code: 'ECONNRESET',
        statusCode: 429,
      },
    );
    original.stack =
      'Error: FAKE_PROVIDER_SECRET\n    at provider frame with masked user text';

    const err = normaliseProviderError(original, 'openai', 'OpenAI');
    const cause = err.cause as
      | (Error & {
          originalName?: string;
          code?: string | number;
          status?: number;
        })
      | undefined;
    const inspected = inspect(err, { depth: 5 });

    expect(err.cause).toBeInstanceOf(Error);
    expect(cause?.originalName).toBe('Error');
    expect(cause?.code).toBe('ECONNRESET');
    expect(cause?.status).toBe(429);
    expect(cause?.message).toContain('code=ECONNRESET');
    expect(Object.keys(cause ?? {})).toEqual([]);
    expect(inspected).not.toContain('FAKE_PROVIDER_SECRET');
    expect(inspected).not.toContain('masked user text');
    expect(inspected).toContain('ProviderErrorCause');
  });

  it('drops unsafe provider cause codes instead of leaking them', () => {
    const original = Object.assign(new Error('fetch failed'), {
      code: 'FAKE_PROVIDER_SECRET',
    });

    const err = normaliseProviderError(original, 'openai', 'OpenAI');
    const inspected = inspect(err, { depth: 5 });

    expect((err.cause as { code?: unknown } | undefined)?.code).toBeUndefined();
    expect(inspected).not.toContain('FAKE_PROVIDER_SECRET');
  });

  it('normalises hostile provider error objects without throwing', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('FAKE_PROVIDER_SECRET from getter');
        },
      },
    );

    const err = normaliseProviderError(hostile, 'openai', 'OpenAI');
    const inspected = inspect(err, { depth: 5 });

    expect(err.kind).toBe('unknown');
    expect(err.cause).toBeInstanceOf(Error);
    expect(inspected).not.toContain('FAKE_PROVIDER_SECRET');
  });

  it('normalises network failures as transient', () => {
    const err = normaliseProviderError(
      new Error('fetch failed'),
      'google',
      'Google',
    );

    expect(err.kind).toBe('transient');
    expect(err.providerId).toBe('google');
  });

  it('does not recurse on incidental 3-digit numbers in legacy messages', () => {
    expect(
      normaliseProviderError(new Error('Took 100ms'), 'openai', 'OpenAI').kind,
    ).toBe('unknown');
    expect(
      normaliseProviderError(
        new Error('version 301 redirect'),
        'openai',
        'OpenAI',
      ).kind,
    ).toBe('unknown');
    expect(
      normaliseProviderError(new Error('port 200 closed'), 'google', 'Google')
        .kind,
    ).toBe('unknown');
    expect(
      normaliseProviderError(new Error('Took 4290ms'), 'openai', 'OpenAI')
        .kind,
    ).toBe('unknown');
    expect(
      normaliseProviderError(
        new Error('id 4015 missing'),
        'anthropic',
        'Anthropic',
      ).kind,
    ).toBe('unknown');
    expect(
      normaliseProviderError(
        new Error('path /v1/4030/users'),
        'google',
        'Google',
      ).kind,
    ).toBe('unknown');
  });

  it('only treats numeric error codes as HTTP status when they are in HTTP range', () => {
    const grpcRateLimit = Object.assign(new Error('RESOURCE_EXHAUSTED'), {
      code: 8,
    });
    const grpcUnknown = Object.assign(new Error('provider unavailable'), {
      code: 8,
    });
    const httpCode = Object.assign(new Error('provider code field'), {
      code: 429,
    });
    const httpStatus = Object.assign(new Error('provider status field'), {
      status: 429,
    });

    const rateLimit = normaliseProviderError(grpcRateLimit, 'google', 'Google');
    expect(rateLimit.status).toBeUndefined();
    expect(rateLimit.kind).toBe('rate_limit');

    const unknown = normaliseProviderError(grpcUnknown, 'google', 'Google');
    expect(unknown.status).toBeUndefined();
    expect(unknown.kind).toBe('unknown');

    const codeOnly = normaliseProviderError(httpCode, 'openai', 'OpenAI');
    expect(codeOnly.status).toBe(429);
    expect(codeOnly.kind).toBe('rate_limit');

    const status = normaliseProviderError(httpStatus, 'openai', 'OpenAI');
    expect(status.status).toBe(429);
    expect(status.kind).toBe('rate_limit');
  });

  it('keeps provider metadata out of JSON serialisation', () => {
    const err = new ProviderError({
      providerId: 'openai',
      providerName: 'OpenAI',
      status: 429,
      kind: 'rate_limit',
      retryAfterMs: 10_000,
    });

    expect(JSON.stringify(err)).toBe('{}');
    expect(Object.keys(err)).toEqual([]);
  });

  it('keeps ProviderError cause non-enumerable whether present or absent', () => {
    const withCause = new ProviderError({
      providerId: 'openai',
      providerName: 'OpenAI',
      status: 429,
      kind: 'rate_limit',
      cause: new Error('upstream stack'),
    });
    const withoutCause = new ProviderError({
      providerId: 'openai',
      providerName: 'OpenAI',
      status: 429,
      kind: 'rate_limit',
    });

    expect(withCause.cause).toBeInstanceOf(Error);
    expect((withCause.cause as Error).message).not.toContain('upstream stack');
    expect(withoutCause.cause).toBeUndefined();
    expect(Object.hasOwn(withCause, 'cause')).toBe(true);
    expect(Object.hasOwn(withoutCause, 'cause')).toBe(false);
    expect(Object.keys(withCause)).toEqual([]);
    expect(Object.keys(withoutCause)).toEqual([]);
  });

  it('unwraps ProviderError from a bounded cause chain before legacy message classification', () => {
    const cause = new ProviderError({
      providerId: 'openai',
      providerName: 'OpenAI',
      status: 429,
      kind: 'rate_limit',
      retryAfterMs: 12_000,
    });
    const firstWrapper = new Error('wrapped native-search failure', { cause });
    const secondWrapper = new Error('outer timeout wrapper', {
      cause: firstWrapper,
    });

    expect(providerErrorFromUnknown(secondWrapper)).toBe(cause);
    expect(normaliseProviderError(secondWrapper, 'openai', 'OpenAI')).toBe(
      cause,
    );
  });
});
