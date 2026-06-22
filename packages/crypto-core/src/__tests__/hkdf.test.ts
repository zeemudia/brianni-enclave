import { describe, it, expect } from 'vitest';
import { deriveKey } from '../hkdf';

describe('HKDF-SHA256', () => {
  it('should derive a 32-byte key', async () => {
    const ikm = crypto.getRandomValues(new Uint8Array(32));
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const info = 'conv_key';

    const key = await deriveKey(ikm, salt, info, 32);
    expect(key.byteLength).toBe(32);
  });

  it('should produce different keys for different info strings', async () => {
    const ikm = crypto.getRandomValues(new Uint8Array(32));
    const salt = crypto.getRandomValues(new Uint8Array(32));

    const key1 = await deriveKey(ikm, salt, 'conv_key', 32);
    const key2 = await deriveKey(ikm, salt, 'msg_key', 32);

    expect(Buffer.from(key1).equals(Buffer.from(key2))).toBe(false);
  });

  it('should be deterministic for same inputs', async () => {
    const ikm = new Uint8Array(32).fill(0xab);
    const salt = new Uint8Array(32).fill(0xcd);

    const key1 = await deriveKey(ikm, salt, 'conv_key', 32);
    const key2 = await deriveKey(ikm, salt, 'conv_key', 32);

    expect(Buffer.from(key1).equals(Buffer.from(key2))).toBe(true);
  });
});

// M1 error-handling-audit — input validation on the HKDF wrapper.
describe('input validation (M1)', () => {
  const salt = new Uint8Array(32).fill(1);

  it('rejects an empty ikm', async () => {
    await expect(deriveKey(new Uint8Array(0), salt, 'info', 32)).rejects.toThrow(
      /ikm must be non-empty/,
    );
  });

  it.each([0, -1, 1.5, NaN])('rejects invalid output length %s', async (len) => {
    const ikm = new Uint8Array(32).fill(2);
    await expect(deriveKey(ikm, salt, 'info', len as number)).rejects.toThrow(
      /output length/,
    );
  });

  it('rejects output length beyond the HKDF-SHA256 bound (255 × 32)', async () => {
    const ikm = new Uint8Array(32).fill(2);
    await expect(deriveKey(ikm, salt, 'info', 255 * 32 + 1)).rejects.toThrow(
      /output length/,
    );
  });

  it('accepts the exact HKDF-SHA256 maximum output length (255 × 32)', async () => {
    const ikm = new Uint8Array(32).fill(2);
    const key = await deriveKey(ikm, salt, 'info', 255 * 32);
    expect(key.byteLength).toBe(255 * 32);
  });
});
