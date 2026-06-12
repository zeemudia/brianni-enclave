import vectors from './search-key-vectors.json' with { type: 'json' };

/**
 * Cross-platform HKDF search-key parity vectors.
 *
 * Contract:
 *   HKDF-SHA256(
 *     ikm   = chat_root_material,
 *     salt  = utf8("search_index_salt_v1"),
 *     info  = utf8("search_index_key"),
 *     len   = 32,
 *   )
 *
 * MUST produce the pinned `hmacKeyHex` for every `rootHex` below.
 * Mobile (SubtleCrypto or react-native-quick-crypto) and web
 * (SubtleCrypto) both load these vectors; any drift on either side
 * fails the gate and guarantees cross-device encrypted-search hits
 * stay byte-identical.
 *
 * DO NOT edit the hex values by hand — regenerate them via the
 * canonical `deriveKey` in `@calypso/crypto-core/hkdf`. If the salt
 * or info string ever changes, this file + the search index schema
 * MUST be bumped together and every device re-indexed — otherwise
 * already-indexed tags will silently miss.
 */
export interface SearchKeyVector {
  /** Human-readable fixture name. */
  name: string;
  /** 32-byte chat-root IKM, hex-encoded. */
  rootHex: string;
  /** Canonical HKDF salt — must match `SEARCH_KEY_SALT`. */
  salt: 'search_index_salt_v1';
  /** Canonical HKDF info — must match `SEARCH_KEY_INFO`. */
  info: 'search_index_key';
  /** Output length in bytes — must be 32. */
  len: 32;
  /** Expected lowercase-hex 32-byte HMAC key. */
  hmacKeyHex: string;
}

/** Canonical HKDF salt for the search-index key. */
export const SEARCH_KEY_SALT = 'search_index_salt_v1';
/** Canonical HKDF info for the search-index key. */
export const SEARCH_KEY_INFO = 'search_index_key';
/** Canonical HKDF output length (bytes). */
export const SEARCH_KEY_LENGTH = 32;

export const SEARCH_KEY_VECTORS: readonly SearchKeyVector[] =
  vectors as readonly SearchKeyVector[];
