import { describe, it, expect } from 'vitest';
import { createCipheriv, createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  SEED_KDF_ITERATIONS,
  SEED_KEY_LENGTH_BYTES,
  prepareSeedKeyInputs,
} from '../seed-wrapper.js';
import { SEED_WRAPPER_VECTORS } from '@calypso/crypto-test-vectors/seed-wrapper-vectors';

describe('seed-wrapper cross-platform parity (Node)', () => {
  for (const v of SEED_WRAPPER_VECTORS) {
    it(`vector ${v.id}: ${v.userId}`, () => {
      const { keyData, salt } = prepareSeedKeyInputs(v.userId, v.userEmail);
      expect(keyData).toBe(v.expectedKeyData);
      expect(salt).toBe(v.expectedSalt);

      const wrapKey = pbkdf2Sync(
        keyData,
        salt,
        SEED_KDF_ITERATIONS,
        SEED_KEY_LENGTH_BYTES,
        'sha256',
      );
      expect(wrapKey.toString('hex')).toBe(v.expectedWrapKeyHex);

      // Round-trip: decrypt the vector's expected ciphertext back to the seed.
      const seed = Buffer.from(v.seedHex, 'hex');
      const iv = Buffer.from(v.ivHex, 'hex');
      const ciphertext = Buffer.from(v.expectedCiphertextHex, 'hex');
      const tag = Buffer.from(v.expectedTagHex, 'hex');

      const decipher = createDecipheriv('aes-256-gcm', wrapKey, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      expect(decrypted.toString('hex')).toBe(seed.toString('hex'));

      // Forward direction: encrypt seed under derived wrapKey + IV; should
      // reproduce the vector's ciphertext + tag exactly.
      const cipher = createCipheriv('aes-256-gcm', wrapKey, iv);
      const ct = Buffer.concat([cipher.update(seed), cipher.final()]);
      expect(ct.toString('hex')).toBe(v.expectedCiphertextHex);
      expect(cipher.getAuthTag().toString('hex')).toBe(v.expectedTagHex);

      // Canonical wire format per spec §Contract C:
      //   iv (12) || ciphertext (32) || tag (16) -> base64
      const packed = Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64');
      expect(packed).toBe(v.expectedEncryptedSeedB64);

      // Reverse: parse the base64 envelope and recover seed.
      const envelopeBytes = Buffer.from(v.expectedEncryptedSeedB64, 'base64');
      expect(envelopeBytes.length).toBe(12 + 32 + 16);
      const parsedIv = envelopeBytes.subarray(0, 12);
      const parsedCt = envelopeBytes.subarray(12, 12 + 32);
      const parsedTag = envelopeBytes.subarray(12 + 32);
      expect(parsedIv.toString('hex')).toBe(v.ivHex);
      expect(parsedCt.toString('hex')).toBe(v.expectedCiphertextHex);
      expect(parsedTag.toString('hex')).toBe(v.expectedTagHex);

      const decipherFromEnvelope = createDecipheriv('aes-256-gcm', wrapKey, parsedIv);
      decipherFromEnvelope.setAuthTag(parsedTag);
      const recovered = Buffer.concat([
        decipherFromEnvelope.update(parsedCt),
        decipherFromEnvelope.final(),
      ]);
      expect(recovered.toString('hex')).toBe(seed.toString('hex'));
    });
  }
});
