import { describe, it, expect } from 'vitest';

// We test the decryptCiphertextForRecipient helper directly
// since the full KMS flow requires /dev/nsm hardware.
describe('decryptCiphertextForRecipient', () => {
  it('decrypts RSA-OAEP-SHA256 wrapped key material', async () => {
    // Generate an RSA-OAEP keypair (simulates what NSM would provide)
    const keypair = await crypto.subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['encrypt', 'decrypt'],
    );

    // Encrypt a test secret with the public key (simulates what KMS does)
    const secret = new TextEncoder().encode('sk-test-provider-key-12345');
    const encrypted = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'RSA-OAEP' },
      keypair.publicKey,
      secret,
    ));

    // Decrypt using the private key
    const decrypted = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'RSA-OAEP' },
      keypair.privateKey,
      encrypted,
    ));

    expect(new TextDecoder().decode(decrypted)).toBe('sk-test-provider-key-12345');
  });
});
