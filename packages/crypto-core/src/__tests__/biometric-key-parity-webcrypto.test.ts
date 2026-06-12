// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import {
  BIOMETRIC_PBKDF2_ITERATIONS,
  BIOMETRIC_KEY_LENGTH_BYTES,
  prepareBiometricKeyInputs,
} from '../biometric-key.js';
import { BIOMETRIC_KEY_VECTORS } from '@calypso/crypto-test-vectors/biometric-key-vectors';

/**
 * Web-API parity for Contract B. Mirrors biometric-key-parity.test.ts
 * but uses `crypto.subtle` (the API the web client will call) instead of
 * `node:crypto.pbkdf2Sync`.
 *
 * **What this proves:** the canonical `seedData`+`salt` strings flow
 * through the WebCrypto API surface (importKey + deriveBits + the
 * specific TextEncoder framing the web client uses) and produce the same
 * vector output as `pbkdf2Sync`.
 *
 * **What this does NOT prove:** real cross-engine parity. happy-dom
 * delegates `crypto.subtle` to `node:crypto.webcrypto`, so the underlying
 * primitives are the same as the Node parity test. A divergence between
 * Node and an actual browser engine (Chromium / WebKit / Firefox WebCrypto)
 * is NOT caught here. That engine-level parity is the responsibility of:
 *   - Mobile parity test on `react-native-quick-crypto` (Chunk 9, where
 *     the runtime is genuinely different — uses BoringSSL, not Node's
 *     OpenSSL/WebCrypto wrapper).
 *   - Playwright E2E (Chunk 11) running the live web client against a
 *     real Chromium WebCrypto, exercising the full setup+unlock loop.
 *
 * The parity gate is therefore three-layered: this suite locks the
 * canonical-strings → API-surface contract; mobile (Chunk 9) locks
 * cross-engine parity; Playwright (Chunk 11) locks live-client behavior.
 */

function hexToBytes(hex: string): Uint8Array {
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

async function pbkdf2Web(
  password: string,
  salt: string,
  iterations: number,
  lengthBytes: number,
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: enc.encode(salt),
      iterations,
    },
    baseKey,
    lengthBytes * 8,
  );
  return new Uint8Array(derived);
}

describe('biometric-key cross-platform parity (Web Crypto / happy-dom)', () => {
  for (const v of BIOMETRIC_KEY_VECTORS) {
    it(`vector ${v.id}: ${v.userId}`, async () => {
      const seed = hexToBytes(v.seedHex);
      const { seedData, salt } = prepareBiometricKeyInputs(seed, v.userId, v.userEmail);
      expect(seedData).toBe(v.expectedSeedData);
      expect(salt).toBe(v.expectedSalt);

      const key = await pbkdf2Web(
        seedData,
        salt,
        BIOMETRIC_PBKDF2_ITERATIONS,
        BIOMETRIC_KEY_LENGTH_BYTES,
      );
      expect(bytesToHex(key)).toBe(v.expectedKeyHex);
    });
  }
});
