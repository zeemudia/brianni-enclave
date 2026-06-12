import { describe, it, expect } from 'vitest';
import { analyseStyle } from '@calypso/masking-core';
import { STYLOMETRIC_VECTORS } from '../stylometric-vectors';

describe('stylometric parity vectors', () => {
  it('exports at least 20 vectors', () => {
    expect(STYLOMETRIC_VECTORS.length).toBeGreaterThanOrEqual(20);
  });

  for (const { input, expected } of STYLOMETRIC_VECTORS) {
    it(`reproduces the expected suggestions for ${JSON.stringify(input.slice(0, 40))}`, () => {
      const actual = analyseStyle(input);
      expect(actual).toEqual(expected);
      // Every expected ID must be 16 hex chars (sanity check).
      for (const s of expected) {
        expect(s.id).toMatch(/^[0-9a-f]{16}$/);
      }
    });
  }
});
