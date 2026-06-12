// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import {
  SEED_KDF_ITERATIONS,
  SEED_KEY_LENGTH_BYTES,
  prepareSeedKeyInputs,
} from '../seed-wrapper.js';
import { SEED_WRAPPER_VECTORS } from '@calypso/crypto-test-vectors/seed-wrapper-vectors';

/**
 * Web-API parity for Contract C. Mirrors seed-wrapper-parity.test.ts
 * but uses `crypto.subtle` for AES-256-GCM and PBKDF2 — the path the web
 * client takes when decrypting the server-issued encrypted seed.
 *
 * Same scope caveat as biometric-key-parity-webcrypto.test.ts: happy-dom's
 * crypto.subtle wraps Node's WebCrypto, so this test catches API-surface
 * issues (WebCrypto's ciphertext||tag concat-vs-split, IV BufferSource
 * coercion, importKey arg shapes) but does not exercise an independent
 * crypto engine. Cross-engine parity → Chunk 9 mobile + Chunk 11
 * Playwright. See the docstring on biometric-key-parity-webcrypto.test.ts
 * for the full three-layer parity model.
 */

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, '0');
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveWrapKey(keyData: string, salt: string): Promise<Uint8Array<ArrayBuffer>> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(keyData),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: SEED_KDF_ITERATIONS },
    baseKey,
    SEED_KEY_LENGTH_BYTES * 8,
  );
  return new Uint8Array(derived);
}

async function importGcmKey(rawKey: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

describe('seed-wrapper cross-platform parity (Web Crypto / happy-dom)', () => {
  for (const v of SEED_WRAPPER_VECTORS) {
    it(`vector ${v.id}: ${v.userId}`, async () => {
      const { keyData, salt } = prepareSeedKeyInputs(v.userId, v.userEmail);
      expect(keyData).toBe(v.expectedKeyData);
      expect(salt).toBe(v.expectedSalt);

      const wrapKeyBytes = await deriveWrapKey(keyData, salt);
      expect(bytesToHex(wrapKeyBytes)).toBe(v.expectedWrapKeyHex);

      const wrapKey = await importGcmKey(wrapKeyBytes);

      // Forward: encrypt seed → match expected ciphertext+tag (Web Crypto
      // returns ciphertext||tag concatenated, length = plaintext + 16).
      const seed = hexToBytes(v.seedHex);
      const iv = hexToBytes(v.ivHex);
      const ctTag = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, seed),
      );
      const ct = ctTag.subarray(0, ctTag.length - 16);
      const tag = ctTag.subarray(ctTag.length - 16);
      expect(bytesToHex(ct)).toBe(v.expectedCiphertextHex);
      expect(bytesToHex(tag)).toBe(v.expectedTagHex);

      // Canonical wire format check: iv || ct || tag → base64.
      const packed = new Uint8Array(iv.length + ct.length + tag.length);
      packed.set(iv, 0);
      packed.set(ct, iv.length);
      packed.set(tag, iv.length + ct.length);
      expect(bytesToBase64(packed)).toBe(v.expectedEncryptedSeedB64);

      // Reverse: parse base64 envelope → decrypt → recover seed.
      const envelope = base64ToBytes(v.expectedEncryptedSeedB64);
      expect(envelope.length).toBe(12 + 32 + 16);
      const parsedIv = envelope.subarray(0, 12);
      const parsedRest = envelope.subarray(12);
      const recovered = new Uint8Array(
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv: parsedIv }, wrapKey, parsedRest),
      );
      expect(bytesToHex(recovered)).toBe(v.seedHex);
    });
  }
});
