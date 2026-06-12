import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '../aead';

describe('AES-256-GCM', () => {
  it('should encrypt and decrypt a message', async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const plaintext = new TextEncoder().encode('hello calypso');
    const aad = new TextEncoder().encode('conv-001:0:1');

    const { ciphertext, iv, tag } = await encrypt(key, plaintext, aad);
    const decrypted = await decrypt(key, iv, ciphertext, tag, aad);

    expect(new TextDecoder().decode(decrypted)).toBe('hello calypso');
  });

  it('should reject tampered ciphertext', async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const plaintext = new TextEncoder().encode('sensitive');
    const aad = new TextEncoder().encode('conv-001:0:1');

    const { ciphertext, iv, tag } = await encrypt(key, plaintext, aad);
    ciphertext[0] ^= 0xff; // tamper

    await expect(decrypt(key, iv, ciphertext, tag, aad)).rejects.toThrow();
  });

  it('should reject wrong AAD', async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const plaintext = new TextEncoder().encode('sensitive');
    const aad = new TextEncoder().encode('conv-001:0:1');

    const { ciphertext, iv, tag } = await encrypt(key, plaintext, aad);
    const wrongAad = new TextEncoder().encode('conv-002:0:1');

    await expect(decrypt(key, iv, ciphertext, tag, wrongAad)).rejects.toThrow();
  });

  it('should produce unique IVs across encryptions', async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const plaintext = new TextEncoder().encode('same data');
    const aad = new TextEncoder().encode('conv-001:0:1');

    const result1 = await encrypt(key, plaintext, aad);
    const result2 = await encrypt(key, plaintext, aad);

    // IVs should be different (random 12 bytes)
    expect(Buffer.from(result1.iv).equals(Buffer.from(result2.iv))).toBe(false);
  });
});

// M1 error-handling-audit — WebCrypto accepts 16/24-byte AES keys, so a
// short key silently DOWNGRADED AES-256-GCM to AES-128/192-GCM. Both
// functions must hard-reject any key that is not exactly 32 bytes.
describe('key-length validation (fail-closed, M1)', () => {
  const plaintext = new TextEncoder().encode('hello');
  const aad = new TextEncoder().encode('aad');

  it.each([0, 16, 24, 31, 33, 64])(
    'encrypt rejects a %i-byte key',
    async (len) => {
      const shortKey = crypto.getRandomValues(new Uint8Array(len));
      await expect(encrypt(shortKey, plaintext, aad)).rejects.toThrow(/32-byte key/);
    },
  );

  it.each([0, 16, 24, 31, 33, 64])(
    'decrypt rejects a %i-byte key',
    async (len) => {
      const badKey = crypto.getRandomValues(new Uint8Array(len));
      const goodKey = crypto.getRandomValues(new Uint8Array(32));
      const { ciphertext, iv, tag } = await encrypt(goodKey, plaintext, aad);
      await expect(decrypt(badKey, iv, ciphertext, tag, aad)).rejects.toThrow(/32-byte key/);
    },
  );
});
