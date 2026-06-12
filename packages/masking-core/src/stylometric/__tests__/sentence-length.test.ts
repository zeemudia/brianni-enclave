import { describe, it, expect } from 'vitest';
import { detectSentenceLength } from '../rules/sentence-length';

function repeatWord(word: string, times: number): string {
  return Array.from({ length: times }, () => word).join(' ');
}

describe('sentence length rule', () => {
  it('does not flag a 30-word sentence', () => {
    const input = repeatWord('word', 30) + '.';
    const out = detectSentenceLength(input);
    expect(out).toEqual([]);
  });

  it('splits a 60-word sentence at the nearest middle conjunction', () => {
    // Build: 30 "alpha" + "and" + 29 "beta" + "."  (60 words total: 30 + 30)
    const left = repeatWord('alpha', 30);
    const right = repeatWord('beta', 29);
    const input = `${left} and ${right}.`;
    const out = detectSentenceLength(input);
    expect(out.length).toBe(1);
    const s = out[0];
    expect(s.category).toBe('sentence_length');
    // The match should replace ` and ` with `. ` AND capitalise the next word.
    expect(s.original).toBe(' and beta');
    expect(s.replacement).toBe('. Beta');
    expect(s.confidence).toBe(1.0);
  });

  it('emits no suggestion for a long sentence with no qualifying conjunction', () => {
    const input = repeatWord('alpha', 60) + '.';
    const out = detectSentenceLength(input);
    expect(out).toEqual([]);
  });

  it('lowers confidence to 0.7 when the conjunction is inside an unbalanced paren/quote', () => {
    // 60-word sentence: opening paren before the conjunction, no close -> mid-clause.
    const left = repeatWord('alpha', 15) + ' ( ' + repeatWord('gamma', 14);
    const right = repeatWord('beta', 30);
    const input = `${left} and ${right}.`;
    const out = detectSentenceLength(input);
    expect(out.length).toBe(1);
    expect(out[0].confidence).toBe(0.7);
  });

  it('keeps confidence at 1.0 when contraction apostrophes appear left of the conjunction', () => {
    // Contraction apostrophes in the left side must NOT trigger the mid-clause
    // heuristic — otherwise any long sentence with "can't", "we've", etc. would
    // silently downgrade confidence.
    const left = "we've " + repeatWord('alpha', 14) + " can't " + repeatWord('gamma', 14);
    const right = repeatWord('beta', 30);
    const input = `${left} and ${right}.`;
    const out = detectSentenceLength(input);
    expect(out.length).toBe(1);
    expect(out[0].confidence).toBe(1.0);
  });
});
