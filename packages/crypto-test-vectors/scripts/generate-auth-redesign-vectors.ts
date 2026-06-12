/**
 * Cross-platform parity vector generator for the auth-redesign chunk.
 *
 * Spec: docs/superpowers/specs/2026-04-26-otp-mnemonic-passkey-redesign.md
 *       §"Cross-platform parity & contracts" — Contracts B, C, D.
 *
 * Emits three vector files consumed by the parity test suites:
 *   - biometric-key-vectors.ts   (Contract B — biometric-key derivation)
 *   - seed-wrapper-vectors.ts    (Contract C — server-seed wrapper key)
 *   - verification-blob-vectors.ts (Contract D — verification blob envelope)
 *
 * All inputs (seeds, IVs, chat roots) are deterministic — derived from a
 * fixed master seed via SHA-256 so the script is bit-reproducible. Run
 * a second time should produce a `git diff` of zero.
 */
import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BIOMETRIC_KEY_INFO,
  BIOMETRIC_PBKDF2_ITERATIONS,
  BIOMETRIC_KEY_LENGTH_BYTES,
  prepareBiometricKeyInputs,
} from '@calypso/crypto-core/biometric-key';
import {
  SEED_KDF_ITERATIONS,
  SEED_KEY_LENGTH_BYTES,
  prepareSeedKeyInputs,
} from '@calypso/crypto-core/seed-wrapper';
import {
  VERIFICATION_BLOB_PLAINTEXT,
  serialiseVerificationBlob,
} from '@calypso/crypto-core/verification-blob';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS_DIR = join(__dirname, '..', 'src');

interface Fixture {
  id: string;
  userId: string;
  userEmail: string;
  /** Hex-encoded 32-byte seed derived deterministically from the id. */
  seedHex: string;
}

const FIXTURES: ReadonlyArray<Fixture> = (
  [
    { id: '01', userId: 'user-a', userEmail: 'a@example.test' },
    { id: '02', userId: 'user-b', userEmail: 'b@example.test' },
    { id: '03', userId: 'cuid-cmf03qfg40000abcd1234efgh', userEmail: 'long.user@example.test' },
    { id: '04', userId: 'u', userEmail: 'short@x.io' },
    { id: '05', userId: 'user-with-plus', userEmail: 'plus+tag@example.test' },
    { id: '06', userId: 'user-unicode', userEmail: 'naïve.café@example.test' },
    { id: '07', userId: 'user-mixed', userEmail: 'Mixed.Case@Example.TEST' },
    { id: '08', userId: 'user-empty-local', userEmail: 'a@b.c' },
    {
      id: '09',
      userId: 'user-' + 'x'.repeat(60),
      userEmail: 'long.local.part.with.many.dots@subdomain.example.test',
    },
  ] satisfies Array<Omit<Fixture, 'seedHex'>>
).map((f) => ({
  ...f,
  // Deterministic seed: SHA-256("seed:" + id) produces a 32-byte seed.
  seedHex: createHash('sha256').update(`seed:${f.id}`).digest('hex'),
}));

interface BiometricKeyVector {
  id: string;
  userId: string;
  userEmail: string;
  seedHex: string;
  expectedSeedData: string;
  expectedSalt: string;
  expectedKeyHex: string;
}

interface SeedWrapperVector {
  id: string;
  userId: string;
  userEmail: string;
  seedHex: string;
  ivHex: string;
  expectedKeyData: string;
  expectedSalt: string;
  expectedWrapKeyHex: string;
  expectedCiphertextHex: string;
  expectedTagHex: string;
  /**
   * Canonical stored format from spec §Contract C:
   *   iv (12 bytes) || ciphertext (32 bytes) || tag (16 bytes) -> base64
   * This is what the server persists in `key_derivation_gate.encryptedSeed`
   * and what clients parse back. The split fields above let test runtimes
   * exercise the AES-GCM round-trip; this field locks the wire format.
   */
  expectedEncryptedSeedB64: string;
}

interface VerificationBlobVector {
  id: string;
  chatRootHex: string;
  ivHex: string;
  expectedEnvelopeJson: string;
}

function generateBiometricKeyVectors(): ReadonlyArray<BiometricKeyVector> {
  return FIXTURES.map((f) => {
    const seed = Buffer.from(f.seedHex, 'hex');
    const { seedData, salt } = prepareBiometricKeyInputs(seed, f.userId, f.userEmail);
    const key = pbkdf2Sync(
      seedData,
      salt,
      BIOMETRIC_PBKDF2_ITERATIONS,
      BIOMETRIC_KEY_LENGTH_BYTES,
      'sha256',
    );
    return {
      id: f.id,
      userId: f.userId,
      userEmail: f.userEmail,
      seedHex: f.seedHex,
      expectedSeedData: seedData,
      expectedSalt: salt,
      expectedKeyHex: key.toString('hex'),
    };
  });
}

function generateSeedWrapperVectors(): ReadonlyArray<SeedWrapperVector> {
  return FIXTURES.map((f) => {
    const seed = Buffer.from(f.seedHex, 'hex');
    // Deterministic IV per fixture: SHA-256("iv:seed:" + id), take 12 bytes.
    const iv = createHash('sha256').update(`iv:seed:${f.id}`).digest().subarray(0, 12);
    const { keyData, salt } = prepareSeedKeyInputs(f.userId, f.userEmail);
    const wrapKey = pbkdf2Sync(
      keyData,
      salt,
      SEED_KDF_ITERATIONS,
      SEED_KEY_LENGTH_BYTES,
      'sha256',
    );
    const cipher = createCipheriv('aes-256-gcm', wrapKey, iv);
    const ciphertext = Buffer.concat([cipher.update(seed), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Canonical wire format: iv || ciphertext || tag, base64-encoded.
    const envelope = Buffer.concat([iv, ciphertext, tag]).toString('base64');
    return {
      id: f.id,
      userId: f.userId,
      userEmail: f.userEmail,
      seedHex: f.seedHex,
      ivHex: iv.toString('hex'),
      expectedKeyData: keyData,
      expectedSalt: salt,
      expectedWrapKeyHex: wrapKey.toString('hex'),
      expectedCiphertextHex: ciphertext.toString('hex'),
      expectedTagHex: tag.toString('hex'),
      expectedEncryptedSeedB64: envelope,
    };
  });
}

function generateVerificationBlobVectors(): ReadonlyArray<VerificationBlobVector> {
  return FIXTURES.map((f) => {
    // Chat root: SHA-256("chatroot:" + id) deterministic 32-byte key.
    const chatRoot = createHash('sha256').update(`chatroot:${f.id}`).digest();
    // IV: SHA-256("iv:chatroot:" + id), 12 bytes.
    const iv = createHash('sha256').update(`iv:chatroot:${f.id}`).digest().subarray(0, 12);
    const cipher = createCipheriv('aes-256-gcm', chatRoot, iv);
    const ciphertext = Buffer.concat([
      cipher.update(VERIFICATION_BLOB_PLAINTEXT, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const envelopeJson = serialiseVerificationBlob({
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      v: 1,
    });
    return {
      id: f.id,
      chatRootHex: chatRoot.toString('hex'),
      ivHex: iv.toString('hex'),
      expectedEnvelopeJson: envelopeJson,
    };
  });
}

const BANNER = `// AUTOGENERATED by packages/crypto-test-vectors/scripts/generate-auth-redesign-vectors.ts
// DO NOT EDIT BY HAND. Re-run the generator to refresh.
`;

function emitBiometric(vectors: ReadonlyArray<BiometricKeyVector>): void {
  const json = JSON.stringify(vectors, null, 2);
  const ts = `${BANNER}
export interface BiometricKeyVector {
  id: string;
  userId: string;
  userEmail: string;
  seedHex: string;
  expectedSeedData: string;
  expectedSalt: string;
  /** Lowercase hex of the 32-byte PBKDF2-SHA256 output (10,000 iterations). */
  expectedKeyHex: string;
}

export const BIOMETRIC_KEY_VECTORS: ReadonlyArray<BiometricKeyVector> = ${json};

export const BIOMETRIC_KEY_VECTOR_INFO = ${JSON.stringify(BIOMETRIC_KEY_INFO)};
`;
  writeFileSync(join(VECTORS_DIR, 'biometric-key-vectors.ts'), ts);
}

function emitSeedWrapper(vectors: ReadonlyArray<SeedWrapperVector>): void {
  const json = JSON.stringify(vectors, null, 2);
  const ts = `${BANNER}
export interface SeedWrapperVector {
  id: string;
  userId: string;
  userEmail: string;
  seedHex: string;
  ivHex: string;
  expectedKeyData: string;
  expectedSalt: string;
  /** Lowercase hex of the 32-byte PBKDF2-SHA256 output (100,000 iterations). */
  expectedWrapKeyHex: string;
  /** Lowercase hex of AES-256-GCM ciphertext (excluding tag). */
  expectedCiphertextHex: string;
  /** Lowercase hex of the 16-byte AES-256-GCM auth tag. */
  expectedTagHex: string;
  /**
   * Canonical stored format per spec §Contract C:
   *   iv (12 bytes) || ciphertext (32 bytes) || tag (16 bytes) -> base64
   * This is what server persists in key_derivation_gate.encryptedSeed; the
   * test verifies pack/unpack of this exact string.
   */
  expectedEncryptedSeedB64: string;
}

export const SEED_WRAPPER_VECTORS: ReadonlyArray<SeedWrapperVector> = ${json};
`;
  writeFileSync(join(VECTORS_DIR, 'seed-wrapper-vectors.ts'), ts);
}

function emitVerificationBlob(vectors: ReadonlyArray<VerificationBlobVector>): void {
  const json = JSON.stringify(vectors, null, 2);
  const ts = `${BANNER}
export interface VerificationBlobVector {
  id: string;
  /** Lowercase hex of the 32-byte chat-root key. */
  chatRootHex: string;
  /** Lowercase hex of the 12-byte AES-GCM IV. */
  ivHex: string;
  /**
   * Expected serialised envelope JSON with sorted keys:
   *   {"ciphertext":"<b64>","iv":"<b64>","tag":"<b64>","v":1}
   * Plaintext is the literal "BRIANNI_AI_VERIFIED_v1".
   */
  expectedEnvelopeJson: string;
}

export const VERIFICATION_BLOB_VECTORS: ReadonlyArray<VerificationBlobVector> = ${json};
`;
  writeFileSync(join(VECTORS_DIR, 'verification-blob-vectors.ts'), ts);
}

function main(): void {
  const biometric = generateBiometricKeyVectors();
  const seedWrapper = generateSeedWrapperVectors();
  const verificationBlob = generateVerificationBlobVectors();
  emitBiometric(biometric);
  emitSeedWrapper(seedWrapper);
  emitVerificationBlob(verificationBlob);
  // eslint-disable-next-line no-console
  console.log(
    `Wrote ${biometric.length} biometric-key, ${seedWrapper.length} seed-wrapper, ${verificationBlob.length} verification-blob vectors.`,
  );
  // randomBytes is imported for type-completeness — the deterministic SHA-256
  // chain replaces it. Keep the import to silence tree-shake if added later.
  void randomBytes;
}

main();
