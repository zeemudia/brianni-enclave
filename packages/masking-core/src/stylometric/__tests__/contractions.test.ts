import { describe, it, expect } from 'vitest';
import { detectContractions } from '../rules/contractions';
import { makeId } from '../id';

describe('contractions rule', () => {
  it('expands "can\'t" to "cannot" with confidence 1.0', () => {
    const input = "I can't sleep";
    const out = detectContractions(input);
    expect(out).toHaveLength(1);
    expect(out[0].original).toBe("can't");
    expect(out[0].replacement).toBe('cannot');
    expect(out[0].category).toBe('contraction');
    expect(out[0].startIndex).toBe(2);
    expect(out[0].endIndex).toBe(7);
    expect(out[0].confidence).toBe(1.0);
  });

  it('preserves initial capitalisation: "Can\'t" -> "Cannot"', () => {
    const input = "Can't sleep";
    const out = detectContractions(input);
    expect(out).toHaveLength(1);
    expect(out[0].original).toBe("Can't");
    expect(out[0].replacement).toBe('Cannot');
  });

  it('expands "I\'ve" to "I have" preserving the leading capital', () => {
    const input = "I've eaten";
    const out = detectContractions(input);
    expect(out).toHaveLength(1);
    expect(out[0].original).toBe("I've");
    expect(out[0].replacement).toBe('I have');
  });

  it('does not match inside a word ("scant\'ly" has no boundary before "t")', () => {
    const input = "scant'ly";
    const out = detectContractions(input);
    expect(out).toEqual([]);
  });

  it('emits multiple suggestions when multiple contractions appear', () => {
    const input = "I don't know, they're late";
    const out = detectContractions(input);
    // Expect at least 2 distinct suggestions (don't, they're)
    const originals = out.map((s) => s.original);
    expect(originals).toContain("don't");
    expect(originals).toContain("they're");
  });

  it('assigns deterministic 16-char ids', () => {
    const out = detectContractions("I can't go");
    expect(out[0].id).toHaveLength(16);
    expect(out[0].id).toMatch(/^[0-9a-f]{16}$/);
  });

  describe('Appendix A coverage', () => {
    it.each([
      ["could've", 'could have'],
      ["he'd", 'he had'],
      ["he'll", 'he will'],
      ["it'd", 'it would'],
      ["it'll", 'it will'],
      ["might've", 'might have'],
      ["must've", 'must have'],
      ["needn't", 'need not'],
      ["she'd", 'she had'],
      ["she'll", 'she will'],
      ["should've", 'should have'],
      ["that'd", 'that would'],
      ["that'll", 'that will'],
      ["would've", 'would have'],
    ])('expands %s → %s', (from, to) => {
      const input = `Well ${from} be great`;
      const out = detectContractions(input);
      const hit = out.find((s) => s.original === from);
      expect(hit).toBeDefined();
      expect(hit?.replacement).toBe(to);
      expect(hit?.confidence).toBe(1.0);
    });

    it('defaults ambiguous "I\'d" to "I had" per Appendix A', () => {
      const input = "I'd go";
      const out = detectContractions(input);
      const hit = out.find((s) => s.original === "I'd");
      expect(hit?.replacement).toBe('I had');
    });
  });

  describe('mutation hardening', () => {
    it('does not rewrite a contraction whose span is excluded', () => {
      // Kills `if (spanIsExcluded(...)) continue` -> false. "can't" is at [2,7).
      expect(detectContractions("I can't sleep", [[2, 7]])).toEqual([]);
      // Sanity: without the exclusion it IS flagged.
      expect(detectContractions("I can't sleep")).toHaveLength(1);
    });

    it("derives the suggestion id from the 'contraction' category", () => {
      // Kills `makeId('contraction', ...)` -> `makeId('', ...)`.
      const out = detectContractions("I can't sleep");
      expect(out).toHaveLength(1);
      const s = out[0];
      expect(s.id).toBe(makeId('contraction', s.startIndex, s.endIndex, s.original));
    });
  });
});
