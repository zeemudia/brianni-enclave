import { describe, it, expect } from 'vitest';
import {
  VERIFICATION_BLOB_PLAINTEXT,
  serialiseVerificationBlob,
  parseVerificationBlob,
} from '../verification-blob.js';

describe('verification blob envelope', () => {
  it('plaintext literal matches spec', () => {
    expect(VERIFICATION_BLOB_PLAINTEXT).toBe('BRIANNI_AI_VERIFIED_v1');
  });

  it('serialise emits sorted-JSON keys', () => {
    const json = serialiseVerificationBlob({
      ciphertext: 'CT',
      iv: 'IV',
      tag: 'TAG',
      v: 1,
    });
    expect(json).toBe('{"ciphertext":"CT","iv":"IV","tag":"TAG","v":1}');
  });

  it('parse rejects unknown version', () => {
    expect(() =>
      parseVerificationBlob('{"ciphertext":"x","iv":"y","tag":"z","v":2}'),
    ).toThrow(/unsupported verification blob version/);
  });

  it('round-trip serialise → parse', () => {
    const env = { ciphertext: 'a', iv: 'b', tag: 'c', v: 1 as const };
    expect(parseVerificationBlob(serialiseVerificationBlob(env))).toEqual(env);
  });

  it.each([
    ['ciphertext', { iv: 'y', tag: 'z', v: 1 }],
    ['iv', { ciphertext: 'x', tag: 'z', v: 1 }],
    ['tag', { ciphertext: 'x', iv: 'y', v: 1 }],
    ['ciphertext', { ciphertext: 123, iv: 'y', tag: 'z', v: 1 }],
    ['iv', { ciphertext: 'x', iv: null, tag: 'z', v: 1 }],
    ['tag', { ciphertext: 'x', iv: 'y', tag: ['z'], v: 1 }],
  ])('parse rejects missing or non-string %s', (_field, envelope) => {
    expect(() => parseVerificationBlob(JSON.stringify(envelope))).toThrow(
      /verification blob: missing required fields/,
    );
  });
});

// L4 error-handling-audit — JSON.parse('null') used to crash with a raw
// TypeError on property access before the clean version error could fire.
describe('parse rejects non-object JSON with a typed message (L4)', () => {
  it.each(['null', '"a string"', '42', 'true', '[]'])('rejects %s', (json) => {
    expect(() => parseVerificationBlob(json)).toThrow(
      /verification blob: expected a JSON object/,
    );
  });

  it('rejects JSON null specifically without a raw TypeError', () => {
    expect(() => parseVerificationBlob('null')).toThrow(
      /verification blob: expected a JSON object/,
    );
  });
});
