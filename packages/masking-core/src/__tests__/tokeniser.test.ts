import { describe, it, expect } from 'vitest';
import { PIITokeniser } from '../tokeniser';
import { detectPII } from '../patterns';

describe('PIITokeniser', () => {
  it('should mask PII and rehydrate correctly', () => {
    const tokeniser = new PIITokeniser();
    const input = 'My name is Dr. Osazee Edigin, email osazee@example.com';
    const entities = detectPII(input);
    const { masked } = tokeniser.mask(input, entities);

    expect(masked).not.toContain('Osazee');
    expect(masked).not.toContain('osazee@example.com');
    expect(masked).toContain('[NAME_1]');
    expect(masked).toContain('[EMAIL_1]');

    const rehydrated = tokeniser.rehydrate(masked);
    expect(rehydrated).toContain('Dr. Osazee Edigin');
    expect(rehydrated).toContain('osazee@example.com');
  });

  it('should leave unknown tokens as-is during rehydration', () => {
    const tokeniser = new PIITokeniser();
    const input = 'I saw Dr. Osazee Edigin';
    const entities = detectPII(input);
    tokeniser.mask(input, entities);

    // The model generates a token [NAME_2] that we never masked — should be left as-is
    const response = 'Ask [NAME_1] and [NAME_2] about it';
    const rehydrated = tokeniser.rehydrate(response);
    expect(rehydrated).toContain('Dr. Osazee Edigin');
    expect(rehydrated).toContain('[NAME_2]'); // unknown token left as-is
  });

  it('should produce correct token format', () => {
    const tokeniser = new PIITokeniser();
    const input = 'Email osazee@example.com and dr@example.com';
    const entities = detectPII(input);
    const { tokens } = tokeniser.mask(input, entities);

    expect(tokens).toHaveLength(2);
    expect(tokens[0].token).toMatch(/\[EMAIL_\d+\]/);
    expect(tokens[1].token).toMatch(/\[EMAIL_\d+\]/);
  });

  it('should clear state between conversations', () => {
    const tokeniser = new PIITokeniser();
    const input = 'Email osazee@example.com';
    const entities = detectPII(input);
    tokeniser.mask(input, entities);

    tokeniser.clear();

    const rehydrated = tokeniser.rehydrate('[EMAIL_1]');
    expect(rehydrated).toBe('[EMAIL_1]'); // no mapping after clear
  });

  it('should add TEE-discovered tokens and rehydrate them', () => {
    const tokeniser = new PIITokeniser();

    // Simulate TEE adding tokens it discovered during second-pass masking
    tokeniser.addTEETokens([
      {
        token: '[NAME_1]',
        original: 'John Smith',
        type: 'NAME',
        startIndex: 0,
        endIndex: 10,
        confidence: 0.95,
      },
    ]);

    const result = tokeniser.rehydrate('Hello [NAME_1], how are you?');
    expect(result).toBe('Hello John Smith, how are you?');
  });

  it('should handle empty entity list gracefully', () => {
    const tokeniser = new PIITokeniser();
    const { masked, tokens } = tokeniser.mask('No PII here', []);
    expect(masked).toBe('No PII here');
    expect(tokens).toHaveLength(0);
  });

  // L7 error-handling-audit — mask() must FAIL CLOSED on invalid entity
  // sets. Overlapping or out-of-range entities silently corrupted the
  // masked output (partially-overwritten tokens, resurfaced PII fragments);
  // corrupted masking must never be sent to the provider.
  describe('entity validation (fail-closed, L7)', () => {
    const entity = (startIndex: number, endIndex: number, type = 'NAME') => ({
      type,
      text: '',
      startIndex,
      endIndex,
      confidence: 0.9,
    });

    it('throws on overlapping entities', () => {
      const text = 'Alice Bobson lives here';
      expect(() =>
        new PIITokeniser().mask(text, [entity(0, 12), entity(6, 12, 'EMAIL')]),
      ).toThrow(/overlap/i);
    });

    it('throws on an entity whose endIndex exceeds the text length', () => {
      const text = 'short';
      expect(() => new PIITokeniser().mask(text, [entity(0, 99)])).toThrow(
        /out of bounds|invalid/i,
      );
    });

    it('throws on negative startIndex', () => {
      expect(() => new PIITokeniser().mask('abc', [entity(-1, 2)])).toThrow(
        /out of bounds|invalid/i,
      );
    });

    it('throws on an empty/inverted range', () => {
      expect(() => new PIITokeniser().mask('abcdef', [entity(3, 3)])).toThrow(
        /invalid/i,
      );
      expect(() => new PIITokeniser().mask('abcdef', [entity(4, 2)])).toThrow(
        /invalid/i,
      );
    });

    it('throws on non-integer positions (cross-text positions / NaN)', () => {
      expect(() => new PIITokeniser().mask('abcdef', [entity(NaN, 3)])).toThrow(
        /invalid/i,
      );
      expect(() => new PIITokeniser().mask('abcdef', [entity(1.5, 3)])).toThrow(
        /invalid/i,
      );
    });

    it('accepts touching-but-not-overlapping entities in any input order', () => {
      const text = 'ab cd';
      const { masked } = new PIITokeniser().mask(text, [
        entity(3, 5, 'EMAIL'),
        entity(0, 2),
      ]);
      expect(masked).toBe('[NAME_1] [EMAIL_1]');
    });
  });
});
