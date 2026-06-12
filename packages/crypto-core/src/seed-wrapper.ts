export const SEED_KEY_INFO = 'brianni-seed-encryption-v1';
export const SEED_KEY_SALT_PREFIX = 'brianni-seed-salt-v1';
export const SEED_KDF_ITERATIONS = 100_000;
export const SEED_KEY_LENGTH_BYTES = 32;

export interface SeedKeyInputs {
  keyData: string;
  salt: string;
}

export function prepareSeedKeyInputs(userId: string, userEmail: string): SeedKeyInputs {
  return {
    keyData: `${userId}:${userEmail}:${SEED_KEY_INFO}`,
    salt: `${SEED_KEY_SALT_PREFIX}:${userId}`,
  };
}
