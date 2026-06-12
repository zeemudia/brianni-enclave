/**
 * Contract B — Biometric-key derivation inputs.
 *
 * Spec: docs/superpowers/specs/2026-04-26-otp-mnemonic-passkey-redesign.md
 *       §"Cross-platform parity & contracts" → Contract B.
 *
 * Canonical input format:
 *   seedData = base64(decryptedSeed) + userId + userEmail + INFO
 *   salt     = INFO + userId
 *
 * **Deliberate deviation from sister project:** sister concatenates the
 * raw-byte seed via `TextDecoder('utf-8', { fatal: false })`, which is
 * non-deterministic across platforms (different decoder implementations
 * substitute U+FFFD at different byte boundaries for malformed UTF-8).
 * The 32-byte CSPRNG seed contains arbitrary bytes including UTF-8-invalid
 * sequences, so sister's contract derives different keys on web vs mobile
 * from the same encrypted seed — a known cross-platform bug. We
 * base64-encode the seed before concatenation: byte-exact across all
 * runtimes, no UTF-8 ambiguity. Parity vectors in Chunk 3 lock this
 * format byte-by-byte across Node, happy-dom, and react-native-quick-crypto.
 *
 * NEVER concatenate raw seed bytes into the PBKDF2 input — base64 is the
 * canonical encoding and the parity vectors will reject any deviation.
 */
export const BIOMETRIC_KEY_INFO = 'Brianni-Biometric-Key-v4';
export const BIOMETRIC_PBKDF2_ITERATIONS = 10_000;
export const BIOMETRIC_KEY_LENGTH_BYTES = 32;

export interface BiometricKeyInputs {
  seedData: string;
  salt: string;
}

/**
 * Cross-platform base64 encode. `btoa` is a global on Node 16+, modern
 * browsers, and React Native 0.71+ (Expo SDK 49+ ships it). Avoid
 * `node:buffer` — it is not available in the React Native bundler runtime
 * and would fork the contract across platforms.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function prepareBiometricKeyInputs(
  decryptedSeed: Uint8Array,
  userId: string,
  userEmail: string,
): BiometricKeyInputs {
  const seedB64 = bytesToBase64(decryptedSeed);
  return {
    seedData: `${seedB64}${userId}${userEmail}${BIOMETRIC_KEY_INFO}`,
    salt: `${BIOMETRIC_KEY_INFO}${userId}`,
  };
}
