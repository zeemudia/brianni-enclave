/**
 * HMAC-SHA256 test vectors for the encrypted search inverted index.
 *
 * These vectors pin the key→tag mapping that @calypso/search-core
 * uses for term lookup. If these fail, a client running older code
 * will query a stale tag and silently miss results, so changes to
 * the tokeniser / hash algorithm must regenerate the vectors and
 * bump the search index schema.
 *
 * Values computed by running
 *   HMAC-SHA256(key = 32 bytes of 0x07, term = <t>)
 * in the same Node 22 SubtleCrypto that mobile + web both use.
 */

export interface SearchHmacVector {
  term: string;
  /** Lowercase hex of the 32-byte HMAC output. */
  tagHex: string;
}

/** Key used to produce every vector below: 32 bytes of 0x07. */
export const SEARCH_VECTOR_KEY = new Uint8Array(32).fill(7);

export const SEARCH_HMAC_VECTORS: readonly SearchHmacVector[] = [
  {
    term: 'hello',
    tagHex:
      '290af183d08286ae740dfed386724985dc666de6350a8df2e8520307ae2503ed',
  },
  {
    term: 'privacy',
    tagHex:
      '1b2ecfacfc68421fa4956ebbfb531d609a8b0216fa212c2225d73c710e0d39f2',
  },
  {
    term: 'calypso',
    tagHex:
      '131f38660bfcaf3c619d12a0cacceee7da7ff88ff5b92a42b00f04202696dc1a',
  },
];
