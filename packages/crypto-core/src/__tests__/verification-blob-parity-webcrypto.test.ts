// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import {
  VERIFICATION_BLOB_PLAINTEXT,
  serialiseVerificationBlob,
  parseVerificationBlob,
} from '../verification-blob.js';
import { VERIFICATION_BLOB_VECTORS } from '@calypso/crypto-test-vectors/verification-blob-vectors';

/**
 * Web-API parity for Contract D. Mirrors verification-blob-parity.test.ts
 * but uses `crypto.subtle` for AES-256-GCM — the path the web client takes
 * when constructing the verification blob and when validating a typed
 * mnemonic on a new device.
 *
 * Same scope caveat as biometric-key-parity-webcrypto.test.ts: happy-dom's
 * crypto.subtle wraps Node's WebCrypto. Cross-engine parity → Chunk 9
 * mobile + Chunk 11 Playwright. See biometric-key-parity-webcrypto.test.ts
 * docstring for the full three-layer parity model.
 */

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
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

async function importGcmKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

describe('verification-blob cross-platform parity (Web Crypto / happy-dom)', () => {
  for (const v of VERIFICATION_BLOB_VECTORS) {
    it(`vector ${v.id}`, async () => {
      const chatRootBytes = hexToBytes(v.chatRootHex);
      const iv = hexToBytes(v.ivHex);
      const key = await importGcmKey(chatRootBytes);

      // Forward: encrypt VERIFICATION_BLOB_PLAINTEXT, serialise, expect
      // byte-equal envelope JSON.
      const enc = new TextEncoder();
      const ctTag = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv },
          key,
          enc.encode(VERIFICATION_BLOB_PLAINTEXT),
        ),
      );
      const ct = ctTag.subarray(0, ctTag.length - 16);
      const tag = ctTag.subarray(ctTag.length - 16);
      const envelopeJson = serialiseVerificationBlob({
        ciphertext: bytesToBase64(ct),
        iv: bytesToBase64(iv),
        tag: bytesToBase64(tag),
        v: 1,
      });
      expect(envelopeJson).toBe(v.expectedEnvelopeJson);

      // Reverse: parse envelope → decrypt → expect literal plaintext.
      const env = parseVerificationBlob(v.expectedEnvelopeJson);
      const ctBytes = base64ToBytes(env.ciphertext);
      const tagBytes = base64ToBytes(env.tag);
      const ivBytes = base64ToBytes(env.iv);
      const combined = new Uint8Array(ctBytes.length + tagBytes.length);
      combined.set(ctBytes, 0);
      combined.set(tagBytes, ctBytes.length);
      const plaintextBytes = new Uint8Array(
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes }, key, combined),
      );
      expect(new TextDecoder().decode(plaintextBytes)).toBe(VERIFICATION_BLOB_PLAINTEXT);
    });
  }
});
