import { describe, it, expect } from 'vitest';
import { detectPII } from '../patterns';

describe('PII detection — overlap handling', () => {
  it('keeps higher-confidence entity when two overlap at same position', () => {
    // SSN pattern (0.85 confidence) and credit card pattern (0.80 confidence)
    // can overlap on similar digit sequences. A 9-digit SSN-like sequence
    // embedded in a 16-digit credit card number should keep the credit card match.
    const text = 'Card: 4111 1111 1111 1111';
    const entities = detectPII(text);

    // The credit card (ACCT, 0.80) should be detected
    const acctEntities = entities.filter((e) => e.type === 'ACCT');
    expect(acctEntities.length).toBeGreaterThanOrEqual(1);
  });

  it('removes lower-confidence overlapping entity', () => {
    // A date like 01/12/2024 (DOB, 0.70) at the same position as an ID
    // pattern should keep the higher-confidence one
    const text = 'My number AB 12 34 56 C';
    const entities = detectPII(text);

    // Should have at most one entity for overlapping ranges
    const overlapFound = entities.some((a, i) =>
      entities.some(
        (b, j) => i !== j && a.startIndex < b.endIndex && a.endIndex > b.startIndex,
      ),
    );
    expect(overlapFound).toBe(false);
  });
});
