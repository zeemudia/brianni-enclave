import { webcrypto } from 'node:crypto';

const subtle = webcrypto.subtle;
const IV_LENGTH = 12;

// Node's webcrypto.CryptoKey and the global CryptoKey diverge in TS 6.
type NodeCryptoKey = webcrypto.CryptoKey;

/** Ensure a buffer has ArrayBuffer backing (not SharedArrayBuffer) for SubtleCrypto. */
function asBufferSource(data: Buffer | Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(data) as Uint8Array<ArrayBuffer>;
}

/**
 * Encrypt a chunk with AES-256-GCM. Returns: IV (12 bytes) || ciphertext || tag (16 bytes).
 * A fresh random IV is generated per call.
 */
export async function encryptChunk(
  sessionKey: NodeCryptoKey,
  plaintext: Buffer,
): Promise<Buffer> {
  const iv = webcrypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv },
    sessionKey,
    asBufferSource(plaintext),
  );
  const result = Buffer.allocUnsafe(IV_LENGTH + ciphertext.byteLength);
  Buffer.from(iv).copy(result, 0);
  Buffer.from(ciphertext).copy(result, IV_LENGTH);
  return result;
}

/**
 * Decrypt a chunk. Input format: IV (12 bytes) || ciphertext || tag (16 bytes).
 *
 * SubtleCrypto rejects with a bare OperationError ("The operation failed
 * for an operation-specific reason"), which upstream error_code mapping
 * cannot classify — failures were misreported as PROVIDER_UNAVAILABLE.
 * Rethrow as a typed DECRYPT_FAILED error (still fail-closed; the static
 * message carries no key or payload material).
 */
export async function decryptChunk(
  sessionKey: NodeCryptoKey,
  encrypted: Buffer,
): Promise<Buffer> {
  const iv = asBufferSource(encrypted.subarray(0, IV_LENGTH));
  const ciphertext = asBufferSource(encrypted.subarray(IV_LENGTH));
  let plaintext: ArrayBuffer;
  try {
    plaintext = await subtle.decrypt(
      { name: 'AES-GCM', iv },
      sessionKey,
      ciphertext,
    );
  } catch {
    throw new Error('DECRYPT_FAILED: AES-GCM decryption failed');
  }
  return Buffer.from(plaintext);
}

/**
 * Zero sensitive memory. Works on Buffer and Uint8Array.
 */
export function zeroBuffer(buf: Buffer | Uint8Array): void {
  buf.fill(0);
}
