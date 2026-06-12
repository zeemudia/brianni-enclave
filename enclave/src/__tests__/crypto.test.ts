import { describe, it, expect } from 'vitest';
import { encryptChunk, decryptChunk, zeroBuffer } from '../crypto';
import { webcrypto } from 'node:crypto';

const subtle = webcrypto.subtle;

async function generateSessionKey() {
  return subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]) as Promise<CryptoKey>;
}

describe('enclave crypto', () => {
  it('encrypts and decrypts a chunk round-trip', async () => {
    const key = await generateSessionKey();
    const plaintext = Buffer.from('{"choices":[{"delta":{"content":"Hello"}}]}');

    const encrypted = await encryptChunk(key, plaintext);
    expect(encrypted.length).toBeGreaterThan(plaintext.length); // IV + ciphertext + tag

    const decrypted = await decryptChunk(key, encrypted);
    expect(decrypted.toString()).toBe(plaintext.toString());
  });

  it('uses a unique 12-byte IV per encryption', async () => {
    const key = await generateSessionKey();
    const plaintext = Buffer.from('same content');

    const enc1 = await encryptChunk(key, plaintext);
    const enc2 = await encryptChunk(key, plaintext);

    // First 12 bytes are IV — should differ
    expect(enc1.subarray(0, 12).equals(enc2.subarray(0, 12))).toBe(false);
  });

  it('rejects tampered ciphertext', async () => {
    const key = await generateSessionKey();
    const encrypted = await encryptChunk(key, Buffer.from('data'));

    // Flip a byte in the ciphertext body
    encrypted[15] ^= 0xff;

    await expect(decryptChunk(key, encrypted)).rejects.toThrow();
  });

  it('zeroBuffer fills with zeroes', () => {
    const buf = Buffer.from([1, 2, 3, 4, 5]);
    zeroBuffer(buf);
    expect(buf.every((b) => b === 0)).toBe(true);
  });

  it('zeroBuffer handles Uint8Array', () => {
    const arr = new Uint8Array([10, 20, 30]);
    zeroBuffer(arr);
    expect(Array.from(arr)).toEqual([0, 0, 0]);
  });
});
