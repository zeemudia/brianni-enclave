import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import { createCipheriv, pbkdf2Sync } from 'node:crypto';
import {
  BIOMETRIC_KEY_INFO,
  BIOMETRIC_PBKDF2_ITERATIONS,
  BIOMETRIC_KEY_LENGTH_BYTES,
  prepareBiometricKeyInputs,
} from '../biometric-key.js';
import {
  SEED_KEY_INFO,
  SEED_KEY_SALT_PREFIX,
  SEED_KDF_ITERATIONS,
  SEED_KEY_LENGTH_BYTES,
  prepareSeedKeyInputs,
} from '../seed-wrapper.js';
import {
  VERIFICATION_BLOB_PLAINTEXT,
  serialiseVerificationBlob,
} from '../verification-blob.js';

/**
 * Frozen golden vectors for Contracts B/C/D.
 *
 * **Why this file is separate from the *-parity.test.ts suites:** those
 * suites consume `BIOMETRIC_KEY_VECTORS` etc, which are emitted by
 * `generate-auth-redesign-vectors.ts`. A future PR that changes a constant
 * (e.g. `BIOMETRIC_KEY_INFO`) AND re-runs the generator AND commits the
 * new vector files would keep those parity suites green — the contract
 * silently slipped underneath them.
 *
 * The goldens below are HAND-PINNED. They are NOT computed via
 * `prepareBiometricKeyInputs` / `prepareSeedKeyInputs` — every byte of
 * every expected value was computed once outside the implementation and
 * is locked in source. A future PR that changes ANY of:
 *   - `BIOMETRIC_KEY_INFO` (string)
 *   - `BIOMETRIC_PBKDF2_ITERATIONS` (number)
 *   - The seedData concat order or base64 encoding
 *   - `SEED_KEY_INFO` / `SEED_KEY_SALT_PREFIX` / `SEED_KDF_ITERATIONS`
 *   - The seed-wrapper keyData/salt construction
 *   - `VERIFICATION_BLOB_PLAINTEXT`
 *   - The sorted-JSON envelope shape `{ciphertext,iv,tag,v}`
 * will fail this suite — even if the parity vector files are
 * regenerated to match. That is the regression guard Codex round 3
 * called for: parity vectors lock the value chain through the
 * implementation; these goldens lock the implementation itself.
 *
 * Update protocol: any change to a constant above MUST come with a
 * deliberate edit to this file documenting the rationale in the PR
 * description. Tests passing here without a corresponding constant
 * update is impossible.
 */

describe('Auth-redesign frozen goldens — Contract B (biometric-key)', () => {
  it('canonical constants are byte-frozen', () => {
    // If these change, every device's encrypted local mnemonic becomes
    // undecryptable. Treat as a wire format.
    expect(BIOMETRIC_KEY_INFO).toBe('Brianni-Biometric-Key-v4');
    expect(BIOMETRIC_PBKDF2_ITERATIONS).toBe(10_000);
    expect(BIOMETRIC_KEY_LENGTH_BYTES).toBe(32);
  });

  it('canonical seedData/salt for a frozen 32-byte all-7s seed', () => {
    const seed = new Uint8Array(32).fill(7);
    const { seedData, salt } = prepareBiometricKeyInputs(
      seed,
      'frozen-user-id',
      'frozen@example.test',
    );
    // Expected values computed once, locked here. Never regenerate from
    // the live implementation — recompute by hand if the contract changes.
    expect(seedData).toBe(
      'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=' +
        'frozen-user-id' +
        'frozen@example.test' +
        'Brianni-Biometric-Key-v4',
    );
    expect(salt).toBe('Brianni-Biometric-Key-v4frozen-user-id');
  });

  it('PBKDF2 over the frozen seedData/salt produces the expected key', () => {
    const seedData =
      'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=' +
      'frozen-user-id' +
      'frozen@example.test' +
      'Brianni-Biometric-Key-v4';
    const salt = 'Brianni-Biometric-Key-v4frozen-user-id';
    const key = pbkdf2Sync(
      seedData,
      salt,
      BIOMETRIC_PBKDF2_ITERATIONS,
      BIOMETRIC_KEY_LENGTH_BYTES,
      'sha256',
    );
    // 64-char hex computed once and locked.
    expect(key.toString('hex')).toBe(
      'c3bc11710ecb9e295955c3f665423e29430de180e62dc09a6c2f08f88251b063',
    );
  });
});

describe('Auth-redesign frozen goldens — Contract C (seed-wrapper)', () => {
  it('canonical constants are byte-frozen', () => {
    expect(SEED_KEY_INFO).toBe('brianni-seed-encryption-v1');
    expect(SEED_KEY_SALT_PREFIX).toBe('brianni-seed-salt-v1');
    expect(SEED_KDF_ITERATIONS).toBe(100_000);
    expect(SEED_KEY_LENGTH_BYTES).toBe(32);
  });

  it('canonical keyData/salt for a frozen userId/email', () => {
    const { keyData, salt } = prepareSeedKeyInputs('frozen-user-id', 'frozen@example.test');
    expect(keyData).toBe(
      'frozen-user-id:frozen@example.test:brianni-seed-encryption-v1',
    );
    expect(salt).toBe('brianni-seed-salt-v1:frozen-user-id');
  });

  it('PBKDF2 over the frozen keyData/salt + AES-GCM produces the expected envelope', () => {
    const keyData = 'frozen-user-id:frozen@example.test:brianni-seed-encryption-v1';
    const salt = 'brianni-seed-salt-v1:frozen-user-id';
    const wrapKey = pbkdf2Sync(
      keyData,
      salt,
      SEED_KDF_ITERATIONS,
      SEED_KEY_LENGTH_BYTES,
      'sha256',
    );
    expect(wrapKey.toString('hex')).toBe(
      'c00efde815e74eae1d8517df45edd9154aa55c5492c3b13372bc046f8fe720ec',
    );

    // Frozen 32-byte seed (all-7s) + frozen 12-byte IV (all-0x42).
    const seed = Buffer.alloc(32, 0x07);
    const iv = Buffer.alloc(12, 0x42);
    const cipher = createCipheriv('aes-256-gcm', wrapKey, iv);
    const ct = Buffer.concat([cipher.update(seed), cipher.final()]);
    const tag = cipher.getAuthTag();

    // Encrypted seed envelope: iv || ct || tag, base64.
    const envelope = Buffer.concat([iv, ct, tag]).toString('base64');
    // 80 bytes (12 iv + 32 ct + 16 tag) → 108-char base64. Computed once, locked.
    expect(envelope).toBe(
      'QkJCQkJCQkJCQkJCrw0xrZG8gLiSpfHdCTx4aaqimDlK4YAXi+tlKXwDBPRl0XhlUJEoVa7qSGsH87m6',
    );
  });
});

describe('Auth-redesign frozen goldens — Contract D (verification-blob)', () => {
  it('plaintext literal is byte-frozen', () => {
    expect(VERIFICATION_BLOB_PLAINTEXT).toBe('BRIANNI_AI_VERIFIED_v1');
  });

  it('AES-GCM(plaintext, frozen-key, frozen-iv) → frozen sorted-JSON envelope', () => {
    const chatRoot = Buffer.alloc(32, 0xab);
    const iv = Buffer.alloc(12, 0xcd);
    const cipher = createCipheriv('aes-256-gcm', chatRoot, iv);
    const ct = Buffer.concat([
      cipher.update(VERIFICATION_BLOB_PLAINTEXT, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const json = serialiseVerificationBlob({
      ciphertext: ct.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      v: 1,
    });
    // Expected serialised JSON computed once and locked.
    expect(json).toBe(
      '{"ciphertext":"05qYTApmfAw6fEG1L/RyO/F8HmBXYQ==","iv":"zc3Nzc3Nzc3Nzc3N","tag":"8N/wYyFJOmkElUcdSg26vg==","v":1}',
    );
  });
});
