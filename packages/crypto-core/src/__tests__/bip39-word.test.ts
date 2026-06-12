/**
 * isBip39Word — wordlist membership predicate used by the client
 * recovery screens to give per-word "not in the wordlist" feedback
 * (launch-readiness audit 2026-06-10, UX finding 1).
 *
 * Threat-model note: this predicate only ever echoes membership of a
 * word the user themselves typed (already visible on their screen)
 * against the PUBLIC BIP-39 english wordlist. It reveals nothing about
 * the account's actual phrase — checksum/account mismatches keep their
 * deliberately generic copy.
 */
import { describe, expect, it } from 'vitest';
import { isBip39Word } from '@calypso/crypto-core/mnemonic';

describe('isBip39Word', () => {
  it('accepts canonical BIP-39 english words', () => {
    // First and last entries of the 2048-word list plus two common ones.
    for (const word of ['abandon', 'ability', 'about', 'zoo']) {
      expect(isBip39Word(word), `expected "${word}" to be a BIP-39 word`).toBe(true);
    }
  });

  it('rejects strings outside the wordlist', () => {
    for (const word of ['aple', 'teh', 'qwerty', 'abandonn', '']) {
      expect(isBip39Word(word), `expected "${word}" to be rejected`).toBe(false);
    }
  });

  it('is exact-match over the canonical lowercase entries — callers normalize case first', () => {
    expect(isBip39Word('Abandon')).toBe(false);
    expect(isBip39Word('ZOO')).toBe(false);
  });
});
