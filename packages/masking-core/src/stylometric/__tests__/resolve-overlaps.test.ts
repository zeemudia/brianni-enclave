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

describe('resolveOverlaps — mutation hardening', () => {
  it('keeps a higher-priority suggestion adjacent AFTER a lower-priority one', () => {
    // The higher-priority punctuation sorts first and is accepted; the idiom
    // touches it at index 5 but does NOT overlap, so both survive. Kills
    // overlaps() `a.startIndex < b.endIndex` -> `<=` (would wrongly treat the
    // touching pair as overlapping once the accepted item starts where the
    // candidate ends).
    const idiom = mk('idiom', 0, 5); // priority 5
    const punct = mk('punctuation', 5, 10); // priority 1 -> accepted first
    const out = resolveOverlaps([idiom, punct]);
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.category).sort()).toEqual(['idiom', 'punctuation']);
  });

  it('keeps the earlier-start span among same-priority overlaps (earliest-first input)', () => {
    // Kills the secondary sort `a.s.startIndex - b.s.startIndex` -> `+`.
    const out = resolveOverlaps([mk('case', 0, 10), mk('case', 5, 15)]);
    expect(out).toHaveLength(1);
    expect(out[0].startIndex).toBe(0);
  });

  it('sorts same-priority overlaps by startIndex regardless of input order', () => {
    // Kills `if (a.s.startIndex !== b.s.startIndex)` -> `===` / false and the
    // priority guard `if (pa !== pb) ...` -> true: the earlier-start span must
    // win even when listed second.
    const out = resolveOverlaps([mk('case', 5, 15), mk('case', 0, 10)]);
    expect(out).toHaveLength(1);
    expect(out[0].startIndex).toBe(0);
  });
});
