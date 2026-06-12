import type { EncryptResult } from './types';

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * AES-256-GCM encrypt with AAD.
 * Returns ciphertext, 12-byte random IV, and 16-byte auth tag.
 *
 * Note: Web Crypto accepts Uint8Array as BufferSource at runtime. TypeScript 5.x
 * narrowed the dom type to ArrayBuffer so we use `as any` to bypass the check
 * without copying data (which would break subarray correctness).
 */
const KEY_LENGTH = 32;

/**
 * M1 error-handling-audit — WebCrypto's importKey accepts 16/24-byte AES
 * keys, which would silently downgrade AES-256-GCM to AES-128/192-GCM.
 * Fail closed on anything that is not exactly 32 bytes.
 */
function assertAes256Key(key: Uint8Array): void {
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `AES-256-GCM requires a 32-byte key, got ${key.length} bytes`,
    );
  }
}

export async function encrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<EncryptResult> {
  assertAes256Key(key);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cryptoKey = await crypto.subtle.importKey('raw', key as any, { name: 'AES-GCM' }, false, [
    'encrypt',
  ]);

  const encrypted = await crypto.subtle.encrypt(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { name: 'AES-GCM', iv: iv as any, additionalData: aad as any, tagLength: TAG_LENGTH * 8 },
    cryptoKey,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plaintext as any,
  );

  // Web Crypto appends the tag to the ciphertext
  const encryptedBytes = new Uint8Array(encrypted);
  const ciphertext = encryptedBytes.slice(0, encryptedBytes.length - TAG_LENGTH);
  const tag = encryptedBytes.slice(encryptedBytes.length - TAG_LENGTH);

  return { ciphertext, iv, tag };
}

/**
 * AES-256-GCM decrypt with AAD.
 * Throws on tampered ciphertext, wrong key, or wrong AAD.
 */
export async function decrypt(
  key: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  assertAes256Key(key);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cryptoKey = await crypto.subtle.importKey('raw', key as any, { name: 'AES-GCM' }, false, [
    'decrypt',
  ]);

  // Web Crypto expects tag appended to ciphertext
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext, 0);
  combined.set(tag, ciphertext.length);

  const decrypted = await crypto.subtle.decrypt(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { name: 'AES-GCM', iv: iv as any, additionalData: aad as any, tagLength: TAG_LENGTH * 8 },
    cryptoKey,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    combined as any,
  );

  return new Uint8Array(decrypted);
}
