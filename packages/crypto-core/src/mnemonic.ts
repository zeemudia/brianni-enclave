import {
  generateMnemonic as _generateMnemonic,
  validateMnemonic as _validateMnemonic,
  mnemonicToEntropy as _mnemonicToEntropy,
  entropyToMnemonic as _entropyToMnemonic,
} from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

/**
 * BIP-39 mnemonic utilities for recovery phrase generation.
 *
 * Uses @scure/bip39 (audited noble crypto suite by Paul Miller).
 * 256-bit entropy produces a 24-word mnemonic.
 *
 * The mnemonic IS the recovery secret — it is shown once during
 * onboarding and never stored by the app or server.
 *
 * Per tech spec s4.1 USER SETUP step 3:
 *   Generate 256-bit random entropy -> BIP-39 mnemonic (24 words)
 */

/**
 * Generate a new 24-word BIP-39 mnemonic from 256 bits of CSPRNG entropy.
 * Uses crypto.getRandomValues internally.
 */
export function generateMnemonic(): string {
  return _generateMnemonic(wordlist, 256);
}

/**
 * Validate that a mnemonic is a well-formed BIP-39 phrase.
 * Checks word count, wordlist membership, and checksum.
 */
export function validateMnemonic(mnemonic: string): boolean {
  return _validateMnemonic(mnemonic, wordlist);
}

/**
 * Convert a BIP-39 mnemonic back to its 32-byte (256-bit) entropy.
 * Used during account recovery to reconstruct the chat root.
 *
 * Design decision: The entropy IS the chat root key.
 * This avoids an extra derivation step and means the 24-word
 * mnemonic directly encodes the 256-bit chat root.
 */
export function mnemonicToEntropy(mnemonic: string): Uint8Array {
  return _mnemonicToEntropy(mnemonic, wordlist);
}

/**
 * Convert 32 bytes of entropy to a 24-word BIP-39 mnemonic.
 * Used to display the recovery phrase for a known chat root.
 */
export function entropyToMnemonic(entropy: Uint8Array): string {
  return _entropyToMnemonic(entropy, wordlist);
}

const wordlistSet = new Set<string>(wordlist);

/**
 * Is `word` one of the 2048 canonical (lowercase) BIP-39 english words?
 *
 * Used by the client recovery screens to point at the exact typed word
 * that can't be part of any valid phrase ("word 7 'aple' isn't in the
 * recovery wordlist") instead of a generic failure. This is safe under
 * the over-the-shoulder threat model: it only echoes the user's own
 * visible input against a PUBLIC wordlist and reveals nothing about
 * the account's actual phrase. Checksum / wrong-account mismatches
 * keep their deliberately generic copy.
 *
 * Exact match over the canonical lowercase entries — callers normalize
 * case/whitespace first.
 */
export function isBip39Word(word: string): boolean {
  return wordlistSet.has(word);
}
