import { describe, expect, it } from 'vitest';
import { SEARCH_HMAC_VECTORS, SEARCH_VECTOR_KEY } from '../search-hmac-vectors';

/**
 * Runs the HMAC vectors through SubtleCrypto (the same path mobile and
 * web use at runtime). If the platform's SubtleCrypto drifts, if the
 * search-core tokeniser changes, or if the HKDF 'search_index_key'
 * derivation changes, these vectors fail — which is exactly when we
 * want to know.
 */
async function hmac(key: Uint8Array, term: string): Promise<string> {
  const keyBytes = new Uint8Array(key.byteLength);
  keyBytes.set(key);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    new TextEncoder().encode(term),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

describe('search HMAC vectors', () => {
  for (const v of SEARCH_HMAC_VECTORS) {
    it(`HMAC-SHA256(key, "${v.term}") matches the pinned tag`, async () => {
      const actual = await hmac(SEARCH_VECTOR_KEY, v.term);
      expect(actual).toBe(v.tagHex);
    });
  }
});
