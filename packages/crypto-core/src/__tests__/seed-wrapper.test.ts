import { describe, it, expect } from 'vitest';
import {
  SEED_KEY_INFO,
  SEED_KEY_SALT_PREFIX,
  SEED_KDF_ITERATIONS,
  SEED_KEY_LENGTH_BYTES,
  prepareSeedKeyInputs,
} from '../seed-wrapper.js';

describe('seed-wrapper inputs', () => {
  it('canonical constants', () => {
    expect(SEED_KEY_INFO).toBe('brianni-seed-encryption-v1');
    expect(SEED_KEY_SALT_PREFIX).toBe('brianni-seed-salt-v1');
    expect(SEED_KDF_ITERATIONS).toBe(100_000);
    expect(SEED_KEY_LENGTH_BYTES).toBe(32);
  });

  it('input concat order: ${userId}:${userEmail}:${INFO}', () => {
    const { keyData, salt } = prepareSeedKeyInputs('u1', 'a@b.test');
    expect(keyData).toBe('u1:a@b.test:brianni-seed-encryption-v1');
    expect(salt).toBe('brianni-seed-salt-v1:u1');
  });
});
