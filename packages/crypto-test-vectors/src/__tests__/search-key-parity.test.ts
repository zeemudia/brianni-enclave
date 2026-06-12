import { describe, expect, it } from 'vitest';
import { deriveKey } from '@calypso/crypto-core/hkdf';
import {
  SEARCH_KEY_VECTORS,
  SEARCH_KEY_SALT,
  SEARCH_KEY_INFO,
  SEARCH_KEY_LENGTH,
} from '../search-key-vectors';

/**
 * Cross-platform HKDF-SHA256 search-key derivation parity gate.
 *
 * Fails if the canonical salt / info / length drift from the frozen
 * fixtures. Mobile and web must each produce these bytes for every
 * rootHex or encrypted search silently diverges across platforms.
 */
describe('search-key parity vectors', () => {
  it('exports at least 5 fixtures', () => {
    expect(SEARCH_KEY_VECTORS.length).toBeGreaterThanOrEqual(5);
  });

  it('canonical constants match the pinned HKDF contract', () => {
    expect(SEARCH_KEY_SALT).toBe('search_index_salt_v1');
    expect(SEARCH_KEY_INFO).toBe('search_index_key');
    expect(SEARCH_KEY_LENGTH).toBe(32);
  });

  for (const v of SEARCH_KEY_VECTORS) {
    it(`derives the pinned search key for ${v.name}`, async () => {
      expect(v.salt).toBe(SEARCH_KEY_SALT);
      expect(v.info).toBe(SEARCH_KEY_INFO);
      expect(v.len).toBe(SEARCH_KEY_LENGTH);

      const root = new Uint8Array(Buffer.from(v.rootHex, 'hex'));
      const salt = new TextEncoder().encode(v.salt);
      const key = await deriveKey(root, salt, v.info, v.len);
      expect(Buffer.from(key).toString('hex')).toBe(v.hmacKeyHex);
    });
  }
});
