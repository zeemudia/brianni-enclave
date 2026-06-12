/**
 * HKDF-SHA256 key derivation per RFC 5869.
 * Used for deriving per-conversation and per-message keys from the chat root.
 */
// RFC 5869 §2.3: HKDF output is capped at 255 × HashLen octets.
const MAX_OUTPUT_BYTES = 255 * 32;

export async function deriveKey(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: string,
  length: number,
): Promise<Uint8Array> {
  // M1 error-handling-audit — validate inputs instead of handing garbage
  // to WebCrypto (whose failure modes vary by runtime).
  if (ikm.length === 0) {
    throw new Error('HKDF ikm must be non-empty');
  }
  if (!Number.isInteger(length) || length <= 0 || length > MAX_OUTPUT_BYTES) {
    throw new Error(
      `HKDF output length must be an integer in [1, ${MAX_OUTPUT_BYTES}], got ${length}`,
    );
  }
  // Web Crypto accepts Uint8Array directly as BufferSource. TypeScript 5.x
  // narrowed the dom type to ArrayBuffer but the runtime accepts ArrayBufferView.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const baseKey = await crypto.subtle.importKey('raw', ikm as any, 'HKDF', false, ['deriveBits']);

  const derived = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      salt: salt as any,
      info: new TextEncoder().encode(info),
    },
    baseKey,
    length * 8,
  );

  return new Uint8Array(derived);
}
