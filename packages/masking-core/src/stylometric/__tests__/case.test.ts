import { describe, it, expect } from 'vitest';
import { detectCase } from '../rules/case';

describe('case rule', () => {
  it('lowercases emphatic ALL-CAPS words mid-sentence', () => {
    const input = 'I am LOVING it';
    const out = detectCase(input);
    expect(out).toHaveLength(1);
    expect(out[0].original).toBe('LOVING');
    expect(out[0].replacement).toBe('loving');
    expect(out[0].category).toBe('case');
    expect(out[0].startIndex).toBe(5);
    expect(out[0].endIndex).toBe(11);
    expect(out[0].confidence).toBe(1.0);
  });

  it('does not flag mid-sentence Capitalised words (only ALL-CAPS)', () => {
    const input = 'She said Wait is needed';
    const out = detectCase(input);
    expect(out).toEqual([]);
  });

  it('does not flag sentence-start Capitalised words', () => {
    const input = 'Wait, the answer';
    const out = detectCase(input);
    expect(out).toEqual([]);
  });

  it('does not flag acronyms from the whitelist (NHS, USA, API, ...)', () => {
    const input = 'Visit the NHS or the USA or read the API';
    const out = detectCase(input);
    expect(out).toEqual([]);
  });

  it('does not flag short acronyms (length <= 3)', () => {
    const input = 'She works at NASA and the UN';
    const out = detectCase(input);
    // "UN" is length 2 => acronym. "NASA" is length 4 but in whitelist.
    expect(out).toEqual([]);
  });

  it('does not flag words preceded by honorifics (Mr., Dr., Mrs., Ms., Prof.)', () => {
    const input = 'Mr. SMITH is here and Dr. JONES left';
    const out = detectCase(input);
    expect(out).toEqual([]);
  });

  it('lowercases ALL-CAPS words longer than 3 that are not whitelisted', () => {
    const input = 'I am SCREAMING loudly';
    const out = detectCase(input);
    expect(out).toHaveLength(1);
    expect(out[0].original).toBe('SCREAMING');
    expect(out[0].replacement).toBe('screaming');
  });

  it('leaves all-caps "I" alone (single character)', () => {
    const input = 'Hello, I am here';
    const out = detectCase(input);
    expect(out).toEqual([]);
  });
});
