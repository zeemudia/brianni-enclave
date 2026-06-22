import { describe, expect, it } from 'vitest';
import { inspect } from 'node:util';

import { normaliseProviderError } from '../providers/errors';

/*
 * Coverage + mutation-hardening for the classifyMessage() fallback ladder in
 * providers/errors.ts. This path is only reached for a STRING error (or an
 * Error whose message carries no extractable 3-digit \b status), so it was
 * previously NoCoverage. It is load-bearing: it is the last resort that turns a
 * bare provider error string into the retry/auth/transient classification that
 * drives fallback routing.
 *
 * Key trick: tokens like `x401x` and `x503x` are matched by hasNumericToken
 * (non-digit boundaries) but NOT by statusFromMessage's `\b([1-5]\d\d)\b`, so
 * they flow through classifyMessage's token/ status branches WITHOUT a status,
 * which is exactly the uncovered region.
 */

function kindOf(error: unknown): string {
  return normaliseProviderError(error, 'openai', 'OpenAI').kind;
}

describe('classifyMessage token branches (status === undefined path)', () => {
  it('classifies a rate-limit token in a bare string as rate_limit', () => {
    expect(kindOf('upstream said rate_limit reached')).toBe('rate_limit');
    expect(kindOf('hit a rate limit just now')).toBe('rate_limit');
    expect(kindOf('resource_exhausted from the model')).toBe('rate_limit');
    expect(kindOf('overloaded_error: try later')).toBe('rate_limit');
  });

  it('classifies a 429 token (non-status-extractable) as rate_limit', () => {
    // `x429x` is matched by hasNumericToken but not by \b429\b, so it stays in
    // the message-token branch with no status.
    expect(kindOf('errorx429xcode')).toBe('rate_limit');
  });

  it('classifies a 401/403 token (non-status-extractable) as auth', () => {
    expect(kindOf('errx401xtoken')).toBe('auth');
    expect(kindOf('errx403xtoken')).toBe('auth');
  });

  it('classifies network/timeout tokens as transient', () => {
    expect(kindOf('fetch failed talking to provider')).toBe('transient');
    expect(kindOf('a network blip occurred')).toBe('transient');
    expect(kindOf('request timeout while streaming')).toBe('transient');
    expect(kindOf('the call timed out')).toBe('transient');
    expect(kindOf('econnreset mid-stream')).toBe('transient');
    expect(kindOf('socket hang up')).toBe('transient');
  });

  it('returns unknown for a string with no recognised token and no status', () => {
    expect(kindOf('something unexpected happened')).toBe('unknown');
  });
});

describe('classifyMessage status fallback (no token, but an extractable status)', () => {
  it('falls back to the embedded \\b status when no direct token matches', () => {
    // No rate/auth/transient token, but a clean \b503\b ⇒ statusFromMessage
    // finds 503 ⇒ classifyStatusAndBody ⇒ server. Kills the `direct !==
    // 'unknown'` → true mutant (which would short-circuit to 'unknown') and
    // covers the `status >= 400` branch.
    expect(kindOf('provider returned 503')).toBe('server');
    expect(kindOf('got a 500 back')).toBe('server');
  });

  it('falls back to auth for an embedded 401/403 status with no token shape', () => {
    expect(kindOf('responded with 401')).toBe('auth');
  });

  it('returns unknown when the only number is a sub-400 status', () => {
    expect(kindOf('redirected with 301')).toBe('unknown');
  });

  it('classifies an embedded 400 status as invalid (>= 400 boundary inclusive)', () => {
    // Pins the `status >= 400` (inclusive) ternary in classifyMessage: 400 must
    // reach classifyStatusAndBody → invalid, not be dropped to unknown by a
    // `> 400` mutant.
    expect(kindOf('bad request 400')).toBe('invalid');
  });
});

describe('redacted-cause suffix structure (formatProviderCauseSuffix)', () => {
  it('emits a parenthesised, space-joined suffix only when details exist', () => {
    const withDetails = normaliseProviderError(
      Object.assign(new Error('boom'), { code: 'ECONNRESET', statusCode: 503 }),
      'openai',
      'OpenAI',
    );
    const causeMsg = (withDetails.cause as Error).message;
    // name + code + status present ⇒ " (name=Error code=ECONNRESET status=503)"
    expect(causeMsg).toMatch(/ \(name=Error code=ECONNRESET status=503\)$/);
    expect(causeMsg.startsWith('provider error cause redacted (')).toBe(true);
  });

  it('omits the suffix entirely when there are no safe details', () => {
    // A plain object with no constructor name in the safe set, no code, no
    // status ⇒ details is empty ⇒ no trailing " (...)" group.
    const noDetails = normaliseProviderError(
      Object.create(null),
      'openai',
      'OpenAI',
    );
    const causeMsg = (noDetails.cause as Error).message;
    expect(causeMsg).toBe('provider error cause redacted');
    expect(causeMsg).not.toContain('(');
    // sanity: nothing leaked
    expect(inspect(noDetails)).toContain('ProviderErrorCause');
  });
});
