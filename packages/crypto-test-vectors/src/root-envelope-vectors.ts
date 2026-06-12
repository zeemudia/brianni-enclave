import vectors from './root-envelope-vectors.json' with { type: 'json' };

/**
 * Cross-platform chat-root envelope parity vectors.
 *
 * Auth-redesign Chunk 9 · Task 9.8: the legacy-KDF-derived wrap parts
 * of these vectors (`wrappedRootKey`, `passphrase`, `wrapSaltHex`,
 * `wrapVersion`) describe the pre-redesign envelope contract that the
 * OTP+passkey+mnemonic redesign supersedes. The vectors are RETAINED
 * because consumers still read `chatRootHex` (and via that, `mnemonic`
 * + `verificationBlob`) for crypto-envelope hydration parity tests.
 * The wrap-related fields persist as historical metadata; no current
 * caller exercises them.
 *
 * Fields with continuing relevance:
 *   - `chatRootHex` — 32-byte CSPRNG-generated root used to seed
 *     hydrate-then-derive parity tests.
 *   - `mnemonic` — BIP-39 24-word phrase whose `mnemonicToEntropy()`
 *     recovers to `chatRootHex`. The redesign uses this same
 *     mnemonic→entropy path for new-device recovery.
 *   - `verificationBlob` — AES-GCM(plaintext, chatRoot). Layout
 *     matches the new Contract D verification blob; tests can use
 *     these as known-good envelopes.
 *
 * Frozen since 2026-04-19. Re-running a generator would invalidate
 * downstream parity expectations; treat the JSON as immutable.
 */
export interface RootEnvelopeVector {
  /** Human-readable fixture name. */
  name: string;
  /**
   * Legacy passphrase from the pre-redesign generator. Retained as
   * historical metadata; no current caller uses it.
   */
  passphrase: string;
  /**
   * Legacy 32-byte salt. Historical metadata; no current caller uses
   * it.
   */
  wrapSaltHex: string;
  /** 32-byte chat root that must be recovered after unwrap. */
  chatRootHex: string;
  /** BIP-39 24-word mnemonic that `mnemonicToEntropy()` recovers to chatRootHex. */
  mnemonic: string;
  /**
   * Legacy wrap version label. Frozen literal kept for JSON shape
   * stability; no current caller branches on it.
   */
  wrapVersion: 'legacy-wrap-v1';
  /** Plaintext the verification blob decrypts to. */
  verificationConstant: 'BRIANNI_CHAT_ROOT_VERIFIED_v1';
  /**
   * Legacy AES-256-GCM wrap. Historical metadata — the redesign uses
   * a different server-issued seed wrap (Contract C); kept for
   * envelope-shape regression coverage.
   */
  wrappedRootKey: {
    ciphertextB64: string;
    ivB64: string;
    tagB64: string;
  };
  /** AES-256-GCM of `BRIANNI_CHAT_ROOT_VERIFIED_v1` under chatRoot directly. */
  verificationBlob: {
    ciphertextB64: string;
    ivB64: string;
    tagB64: string;
  };
}

export const ROOT_ENVELOPE_VECTORS: readonly RootEnvelopeVector[] =
  vectors as readonly RootEnvelopeVector[];
