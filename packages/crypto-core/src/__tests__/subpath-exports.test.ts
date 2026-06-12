/**
 * Smoke test: confirm package.json#exports subpaths work as documented in
 * the spec/plan. Spec assumes consumers do
 *   import { ... } from '@calypso/crypto-core/biometric-key'
 * etc; this test fails closed if a subpath is removed from `exports`.
 */
import { describe, it, expect } from 'vitest';
import { BIOMETRIC_PBKDF2_ITERATIONS } from '@calypso/crypto-core/biometric-key';
import { SEED_KEY_INFO } from '@calypso/crypto-core/seed-wrapper';
import { VERIFICATION_BLOB_PLAINTEXT } from '@calypso/crypto-core/verification-blob';
import { sortedJsonStringify } from '@calypso/crypto-core/sorted-json';

describe('package.json#exports subpaths resolve', () => {
  it('all four new auth helpers are reachable via subpath imports', () => {
    expect(BIOMETRIC_PBKDF2_ITERATIONS).toBe(10_000);
    expect(SEED_KEY_INFO).toBe('brianni-seed-encryption-v1');
    expect(VERIFICATION_BLOB_PLAINTEXT).toBe('BRIANNI_AI_VERIFIED_v1');
    expect(sortedJsonStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});
