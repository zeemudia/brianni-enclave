import { describe, it, expect } from 'vitest';
import {
  BIOMETRIC_KEY_INFO,
  BIOMETRIC_PBKDF2_ITERATIONS,
  BIOMETRIC_KEY_LENGTH_BYTES,
  prepareBiometricKeyInputs,
} from '../biometric-key.js';

describe('biometric-key inputs', () => {
  it('exports the canonical constants', () => {
    expect(BIOMETRIC_KEY_INFO).toBe('Brianni-Biometric-Key-v4');
    expect(BIOMETRIC_PBKDF2_ITERATIONS).toBe(10_000);
    expect(BIOMETRIC_KEY_LENGTH_BYTES).toBe(32);
  });

  it('prepareBiometricKeyInputs concatenates inputs in the canonical order', () => {
    const seed = new Uint8Array(32).fill(7);
    const { seedData, salt } = prepareBiometricKeyInputs(seed, 'user-id-1', 'user@example.test');
    expect(salt).toBe('Brianni-Biometric-Key-v4user-id-1');
    expect(seedData.endsWith('Brianni-Biometric-Key-v4')).toBe(true);
    expect(seedData.includes('user-id-1user@example.test')).toBe(true);
  });

  // Known-answer test for the EXACT base64 contract. This is the regression
  // guard against silent re-introduction of node:buffer or any other base64
  // implementation that disagrees with the canonical Uint8Array → btoa
  // pipeline. Seed deliberately contains UTF-8-invalid bytes (0xff..0xfc,
  // 0x80..0xd3) so that any implementation falling back to TextDecoder will
  // produce a different string and fail this test loudly.
  it('produces byte-exact seedData for a UTF-8-invalid seed (canonical vector)', () => {
    const seed = new Uint8Array([
      0xff, 0xfe, 0xfd, 0xfc, 0x00, 0x01, 0x02, 0x03,
      0x80, 0x81, 0x82, 0x83, 0x90, 0x91, 0x92, 0x93,
      0xa0, 0xa1, 0xa2, 0xa3, 0xb0, 0xb1, 0xb2, 0xb3,
      0xc0, 0xc1, 0xc2, 0xc3, 0xd0, 0xd1, 0xd2, 0xd3,
    ]);
    const { seedData, salt } = prepareBiometricKeyInputs(seed, 'user-id-1', 'user@example.test');

    // Expected base64 of the seed bytes — computed once via btoa, locked here.
    const expectedSeedB64 = '//79/AABAgOAgYKDkJGSk6ChoqOwsbKzwMHCw9DR0tM=';
    const expectedSeedData =
      expectedSeedB64 + 'user-id-1' + 'user@example.test' + 'Brianni-Biometric-Key-v4';

    expect(seedData).toBe(expectedSeedData);
    expect(salt).toBe('Brianni-Biometric-Key-v4user-id-1');
  });

  it('omitting the seed produces a different seedData (regression guard)', () => {
    // Sanity check that the test would fail if the implementation forgot to
    // include the seed in the output — guards against vacuous-pass refactors.
    const seedZero = new Uint8Array(32);
    const seedOne = new Uint8Array(32).fill(0xaa);
    const { seedData: zeroData } = prepareBiometricKeyInputs(seedZero, 'u', 'a@b');
    const { seedData: oneData } = prepareBiometricKeyInputs(seedOne, 'u', 'a@b');
    expect(zeroData).not.toBe(oneData);
  });
});
