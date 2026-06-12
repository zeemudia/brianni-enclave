import { describe, it, expect } from 'vitest';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  VERIFICATION_BLOB_PLAINTEXT,
  serialiseVerificationBlob,
  parseVerificationBlob,
} from '../verification-blob.js';
import { VERIFICATION_BLOB_VECTORS } from '@calypso/crypto-test-vectors/verification-blob-vectors';

describe('verification-blob cross-platform parity (Node)', () => {
  for (const v of VERIFICATION_BLOB_VECTORS) {
    it(`vector ${v.id}`, () => {
      const chatRoot = Buffer.from(v.chatRootHex, 'hex');
      const iv = Buffer.from(v.ivHex, 'hex');

      // Forward: encrypt VERIFICATION_BLOB_PLAINTEXT under chatRoot + IV;
      // serialise; expect byte-equal envelope JSON.
      const cipher = createCipheriv('aes-256-gcm', chatRoot, iv);
      const ciphertext = Buffer.concat([
        cipher.update(VERIFICATION_BLOB_PLAINTEXT, 'utf8'),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      const envelopeJson = serialiseVerificationBlob({
        ciphertext: ciphertext.toString('base64'),
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        v: 1,
      });
      expect(envelopeJson).toBe(v.expectedEnvelopeJson);

      // Reverse: parse the vector envelope, decrypt, expect back to the literal plaintext.
      const env = parseVerificationBlob(v.expectedEnvelopeJson);
      const ct = Buffer.from(env.ciphertext, 'base64');
      const tg = Buffer.from(env.tag, 'base64');
      const ivb = Buffer.from(env.iv, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', chatRoot, ivb);
      decipher.setAuthTag(tg);
      const decrypted = Buffer.concat([decipher.update(ct), decipher.final()]);
      expect(decrypted.toString('utf8')).toBe(VERIFICATION_BLOB_PLAINTEXT);
    });
  }
});
