import vectors from './search-hmac-parity-vectors.json' with { type: 'json' };

/**
 * Cross-platform HMAC-tag parity vectors — the end-to-end user-
 * visible guarantee Task 4.6 locks in.
 *
 * Derivation chain pinned by these vectors:
 *   HKDF-SHA256(
 *     ikm  = chatRoot,
 *     salt = "search_index_salt_v1",
 *     info = "search_index_key",
 *     len  = 32,
 *   )                       — `search-key-vectors.json`
 *     → HMAC-SHA256(key, term) per search-core tokeniser
 *                             — THIS file
 *     → identical conversation-level hit sets per platform
 *                             — `tests/e2e/encrypted-search.test.ts`
 *
 * The vectors were generated once from a canonical chat root using
 * `@calypso/crypto-core/hkdf` + `@calypso/search-core.hmacTerm`.
 * Mobile and web both consume them. Any drift in the tokeniser,
 * salt, info, or HMAC framing fails the gate on both platforms.
 */

export interface SearchHmacParityTerm {
  term: string;
  /** Lowercase hex of the 32-byte HMAC-SHA256 output under the derived search key. */
  tagHex: string;
}

export interface SearchHmacParityQuery {
  q: string;
  /** Conversation ID the query should hit (exactly one). */
  hit: string;
}

export interface SearchHmacParityFixture {
  conversationId: string;
  messageId: string;
  text: string;
}

export interface SearchHmacParityVectors {
  rootHex: string;
  messages: readonly SearchHmacParityFixture[];
  terms: readonly SearchHmacParityTerm[];
  queries: readonly SearchHmacParityQuery[];
}

export const SEARCH_HMAC_PARITY_VECTORS: SearchHmacParityVectors =
  vectors as SearchHmacParityVectors;
