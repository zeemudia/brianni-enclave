import { describe, it, expect } from 'vitest';
import { resolveOverlaps } from '../resolve-overlaps';
import type { StyleSuggestion } from '../types';
import { makeId } from '../id';

function mk(
  category: StyleSuggestion['category'],
  startIndex: number,
  endIndex: number,
  original = 'x',
): StyleSuggestion {
  return {
    id: makeId(category, startIndex, endIndex, original),
    category,
    original,
    replacement: 'y',
    startIndex,
    endIndex,
    confidence: 1.0,
  };
}

describe('resolveOverlaps', () => {
  it('returns the empty array for empty input', () => {
    expect(resolveOverlaps([])).toEqual([]);
  });

  it('keeps non-overlapping suggestions and returns them sorted by startIndex', () => {
    const a = mk('case', 10, 14);
    const b = mk('punctuation', 0, 4);
    const out = resolveOverlaps([a, b]);
    expect(out.map((s) => s.startIndex)).toEqual([0, 10]);
  });

  it('prefers the higher-priority category when two suggestions overlap on the same span', () => {
    const punct = mk('punctuation', 0, 5); // priority 1
    const idiom = mk('idiom', 0, 5); // priority 5
    const out = resolveOverlaps([idiom, punct]);
    expect(out).toHaveLength(1);
    expect(out[0].category).toBe('punctuation');
  });

  it('prefers the higher-priority category when one suggestion is nested in another', () => {
    const outer = mk('idiom', 0, 20); // priority 5
    const inner = mk('case', 5, 10); // priority 2
    const out = resolveOverlaps([outer, inner]);
    expect(out).toHaveLength(1);
    expect(out[0].category).toBe('case');
  });

  it('keeps adjacent (end === next.start) suggestions as both non-overlapping', () => {
    const a = mk('case', 0, 5);
    const b = mk('idiom', 5, 10);
    const out = resolveOverlaps([a, b]);
    expect(out).toHaveLength(2);
  });

  it('is stable for ties on priority + start: prefers the first encountered', () => {
    const first = mk('case', 0, 5, 'alpha');
    const second = mk('case', 0, 5, 'beta');
    const out = resolveOverlaps([first, second]);
    expect(out).toHaveLength(1);
    expect(out[0].original).toBe('alpha');
  });
});
