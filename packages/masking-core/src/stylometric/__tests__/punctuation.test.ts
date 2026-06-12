import { describe, it, expect } from 'vitest';
import { detectPunctuation } from '../rules/punctuation';
import { makeId } from '../id';

describe('punctuation rule', () => {
  it('collapses repeated exclamation marks to a single "!"', () => {
    const input = 'Wait!!! Stop';
    const out = detectPunctuation(input);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      id: makeId('punctuation', 4, 7, '!!!'),
      category: 'punctuation',
      original: '!!!',
      replacement: '!',
      startIndex: 4,
      endIndex: 7,
      confidence: 1.0,
    });
  });

  it('collapses repeated question marks to "?"', () => {
    const input = 'Really???';
    const out = detectPunctuation(input);
    expect(out).toHaveLength(1);
    expect(out[0].original).toBe('???');
    expect(out[0].replacement).toBe('?');
    expect(out[0].startIndex).toBe(6);
    expect(out[0].endIndex).toBe(9);
  });

  it('collapses triple dots to "."', () => {
    const input = 'Hmm...';
    const out = detectPunctuation(input);
    expect(out).toHaveLength(1);
    expect(out[0].original).toBe('...');
    expect(out[0].replacement).toBe('.');
  });

  it('returns empty array when no repeated punctuation is present', () => {
    const out = detectPunctuation('Done. Right!');
    expect(out).toEqual([]);
  });

  it('replaces em dash with "--"', () => {
    const input = 'one — two';
    const out = detectPunctuation(input);
    expect(out).toHaveLength(1);
    expect(out[0].original).toBe('—');
    expect(out[0].replacement).toBe('--');
    expect(out[0].startIndex).toBe(4);
    expect(out[0].endIndex).toBe(5);
  });

  it('collapses repeated commas to ","', () => {
    const input = 'yes,,,no';
    const out = detectPunctuation(input);
    expect(out).toHaveLength(1);
    expect(out[0].original).toBe(',,,');
    expect(out[0].replacement).toBe(',');
  });

  it('confidence is 1.0 for every punctuation suggestion', () => {
    const out = detectPunctuation('!!?? ,,, ...');
    for (const s of out) {
      expect(s.confidence).toBe(1.0);
    }
  });
});
