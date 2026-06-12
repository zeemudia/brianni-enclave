import { describe, it, expect } from 'vitest';
import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToEntropy,
  entropyToMnemonic,
} from '../mnemonic';

describe('BIP-39 mnemonic utilities', () => {
  it('should generate a 24-word mnemonic', () => {
    const mnemonic = generateMnemonic();
    const words = mnemonic.split(' ');
    expect(words).toHaveLength(24);
  });

  it('should generate different mnemonics each call', () => {
    const m1 = generateMnemonic();
    const m2 = generateMnemonic();
    expect(m1).not.toBe(m2);
  });

  it('should validate a correct mnemonic', () => {
    const mnemonic = generateMnemonic();
    expect(validateMnemonic(mnemonic)).toBe(true);
  });

  it('should reject an invalid mnemonic', () => {
    expect(validateMnemonic('not a valid mnemonic phrase')).toBe(false);
  });

  it('should reject a mnemonic with wrong checksum', () => {
    // Take a valid mnemonic and corrupt its checksum by replacing the
    // last word. A single random swap only breaks the checksum ~255/256
    // of the time, so rather than relying on chance we deterministically
    // search the phrase's own words for a last-word substitution that
    // yields an invalid checksum.
    const mnemonic = generateMnemonic();
    const words = mnemonic.split(' ');
    let corrupted: string | null = null;
    for (const candidate of words) {
      if (candidate === words[23]) continue;
      const swapped = [...words.slice(0, 23), candidate].join(' ');
      if (!validateMnemonic(swapped)) {
        corrupted = swapped;
        break;
      }
    }
    expect(corrupted).not.toBeNull();
    expect(validateMnemonic(corrupted!)).toBe(false);
  });

  it('should reject an empty string', () => {
    expect(validateMnemonic('')).toBe(false);
  });

  it('should round-trip entropy -> mnemonic -> entropy', () => {
    const entropy = crypto.getRandomValues(new Uint8Array(32));
    const mnemonic = entropyToMnemonic(entropy);
    const recovered = mnemonicToEntropy(mnemonic);

    expect(Buffer.from(recovered).toString('hex')).toBe(
      Buffer.from(entropy).toString('hex'),
    );
  });

  it('should round-trip mnemonic -> entropy -> mnemonic', () => {
    const mnemonic = generateMnemonic();
    const entropy = mnemonicToEntropy(mnemonic);
    const recovered = entropyToMnemonic(entropy);
    expect(recovered).toBe(mnemonic);
  });

  it('entropy from mnemonic should be 32 bytes (256 bits)', () => {
    const mnemonic = generateMnemonic();
    const entropy = mnemonicToEntropy(mnemonic);
    expect(entropy.byteLength).toBe(32);
  });

  it('should produce deterministic mnemonic for known entropy', () => {
    // Known test vector: 32 bytes of zeros
    const entropy = new Uint8Array(32).fill(0);
    const mnemonic = entropyToMnemonic(entropy);
    // BIP-39 test vector for 256 bits of zeros
    expect(mnemonic).toBe(
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art',
    );
  });

  it('should validate the known test vector mnemonic', () => {
    const knownMnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';
    expect(validateMnemonic(knownMnemonic)).toBe(true);
  });
});
