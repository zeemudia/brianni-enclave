import { describe, it, expect } from 'vitest';
import { analyseStyle } from '@calypso/masking-core';
import { STYLOMETRIC_VECTORS } from '../stylometric-vectors';

describe('stylometric parity vectors', () => {
  it('exports at least 20 vectors', () => {
    expect(STYLOMETRIC_VECTORS.length).toBeGreaterThanOrEqual(20);
  });

  it('pins the code-fence and URL exclusion inputs (not just an empty-result shape)', () => {
    // The two `expected: []` vectors encode a real conformance promise: style
    // analysis must NOT flag `!!!` that lives inside a fenced code block or a
    // URL. Asserting the exact inputs here (and that a BARE `!!!` *is* flagged)
    // keeps the fixture inputs load-bearing — otherwise blanking an input to ""
    // would still satisfy `analyseStyle(input) === []` and silently void the
    // exclusion coverage.
    const fenceVector = STYLOMETRIC_VECTORS.find(
      (v) => v.input === 'before ```!!!``` after',
    );
    const urlVector = STYLOMETRIC_VECTORS.find(
      (v) => v.input === 'visit https://example.com/!!! now',
    );
    expect(fenceVector, 'fenced-code exclusion vector must be present').toBeDefined();
    expect(urlVector, 'URL exclusion vector must be present').toBeDefined();
    expect(fenceVector?.expected).toEqual([]);
    expect(urlVector?.expected).toEqual([]);

    // The exclusion is content-specific: the same `!!!` OUTSIDE a fence/URL is
    // flagged, so an empty (or otherwise altered) input would not reproduce the
    // pinned empty result by coincidence.
    expect(analyseStyle('before ```!!!``` after')).toEqual([]);
    expect(analyseStyle('visit https://example.com/!!! now')).toEqual([]);
    expect(analyseStyle('before !!! after').length).toBeGreaterThan(0);
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
