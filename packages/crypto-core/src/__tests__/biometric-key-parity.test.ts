import { describe, it, expect } from 'vitest';
import { pbkdf2Sync } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  BIOMETRIC_PBKDF2_ITERATIONS,
  BIOMETRIC_KEY_LENGTH_BYTES,
  prepareBiometricKeyInputs,
} from '../biometric-key.js';
import { BIOMETRIC_KEY_VECTORS } from '@calypso/crypto-test-vectors/biometric-key-vectors';

describe('biometric-key cross-platform parity (Node)', () => {
  for (const v of BIOMETRIC_KEY_VECTORS) {
    it(`vector ${v.id}: ${v.userId}`, () => {
      const seedBytes = Buffer.from(v.seedHex, 'hex');
      const seedView = new Uint8Array(
        seedBytes.buffer,
        seedBytes.byteOffset,
        seedBytes.byteLength,
      );
      const { seedData, salt } = prepareBiometricKeyInputs(seedView, v.userId, v.userEmail);
      expect(seedData).toBe(v.expectedSeedData);
      expect(salt).toBe(v.expectedSalt);

      const out = pbkdf2Sync(
        seedData,
        salt,
        BIOMETRIC_PBKDF2_ITERATIONS,
        BIOMETRIC_KEY_LENGTH_BYTES,
        'sha256',
      );
      expect(out.toString('hex')).toBe(v.expectedKeyHex);
    });
  }
});
