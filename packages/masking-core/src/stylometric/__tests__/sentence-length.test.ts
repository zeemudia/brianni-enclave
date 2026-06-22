import { describe, it, expect } from 'vitest';
import { detectSentenceLength } from '../rules/sentence-length';
import { makeId } from '../id';

function repeatWord(word: string, times: number): string {
  return Array.from({ length: times }, () => word).join(' ');
}

describe('sentence length rule', () => {
  it('does not flag a 30-word sentence', () => {
    const input = repeatWord('word', 30) + '.';
    const out = detectSentenceLength(input);
    expect(out).toEqual([]);
  });

  it('does not flag exactly 40 words but flags 41 words', () => {
    expect(detectSentenceLength(`${repeatWord('word', 19)} and ${repeatWord('tail', 20)}.`)).toEqual([]);

    const out = detectSentenceLength(`${repeatWord('word', 20)} and ${repeatWord('tail', 20)}.`);
    expect(out).toHaveLength(1);
    expect(out[0].original).toBe(' and tail');
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

  it('chooses the conjunction nearest the sentence midpoint', () => {
    const input = [
      repeatWord('early', 5),
      'and',
      repeatWord('middle', 22),
      'because',
      repeatWord('late', 31),
    ].join(' ') + '.';
    const out = detectSentenceLength(input);
    expect(out).toHaveLength(1);
    expect(out[0].original).toBe(' because late');
    expect(out[0].replacement).toBe('. Late');
  });

  it('splits independent sentences and leaves short neighbours alone', () => {
    const input = `Short first! ${repeatWord('alpha', 20)} but ${repeatWord('beta', 20)}? Short last.`;
    const out = detectSentenceLength(input);
    expect(out).toHaveLength(1);
    expect(out[0].original).toBe(' but beta');
    expect(input.slice(out[0].startIndex, out[0].endIndex)).toBe(' but beta');
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

  it.each([
    ['bracket', '['],
    ['brace', '{'],
    ['double quote', '"'],
  ])('lowers confidence inside an unbalanced %s', (_name, opener) => {
    const left = repeatWord('alpha', 15) + ` ${opener} ` + repeatWord('gamma', 14);
    const right = repeatWord('beta', 30);
    const out = detectSentenceLength(`${left} and ${right}.`);
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe(0.7);
  });

  it.each([
    ['bracket pair', '[', ']'],
    ['brace pair', '{', '}'],
    ['double quote pair', '"', '"'],
  ])('keeps confidence at 1.0 after a closed %s', (_name, opener, closer) => {
    const left = repeatWord('alpha', 15) + ` ${opener}aside${closer} ` + repeatWord('gamma', 14);
    const right = repeatWord('beta', 30);
    const out = detectSentenceLength(`${left} and ${right}.`);
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe(1.0);
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

describe('sentence length rule — mutation hardening', () => {
  it('actually splits on terminators (two ≤40-word sentences are not merged)', () => {
    // Kills `while (SENTENCE_SPLIT.exec) ...` -> false / `{}`, and the trailing
    // `text.slice(cursor)` -> `text`: each sentence is 25 words (≤40), so only
    // a (wrong) merge into one 50-word sentence would emit a suggestion.
    const input = `${repeatWord('alpha', 12)} and ${repeatWord('beta', 12)}. ${repeatWord('gamma', 25)}`;
    expect(detectSentenceLength(input)).toEqual([]);
  });

  it('flags a long final sentence that has no terminating punctuation', () => {
    // Kills the trailing-segment guards `if (cursor < text.length)` -> false /
    // `cursor >= text.length`, and the inner `if (segment.trim().length > 0)`
    // -> false: a 41-word sentence with no '.' is ONLY reachable as the
    // trailing segment.
    const input = `${repeatWord('alpha', 20)} and ${repeatWord('beta', 20)}`;
    const out = detectSentenceLength(input);
    expect(out).toHaveLength(1);
    expect(out[0].original).toBe(' and beta');
  });

  it('flags a long first sentence followed by a short terminated one', () => {
    // Kills the in-loop `if (segment.trim().length > 0)` -> false and the
    // `m.index + m[0].length` -> `-` end arithmetic: the first (loop) segment
    // must be pushed with the correct span.
    const input = `${repeatWord('alpha', 20)} and ${repeatWord('beta', 20)}. short tail.`;
    const out = detectSentenceLength(input);
    expect(out).toHaveLength(1);
    expect(out[0].original).toBe(' and beta');
  });

  it('collapses runs of whitespace when counting words (a double space is not a word)', () => {
    // Kills `split(/\s+/)` -> `split(/\s/)`: with a double space this sentence
    // is 40 words, but `/\s/` would count an empty token (41) and flag it.
    const input = `${repeatWord('alpha', 9)}  ${repeatWord('alpha', 10)} and ${repeatWord('beta', 20)}.`;
    expect(detectSentenceLength(input)).toEqual([]);
  });

  it('counts words on the trimmed segment (leading space must not inflate the count)', () => {
    // Kills `segment.trim()` -> `segment` in countWords: the second sentence is
    // exactly 40 words but carries a leading space; without trimming it would
    // count as 41 and be wrongly flagged.
    const input = `First. ${repeatWord('beta', 19)} and ${repeatWord('gamma', 20)}.`;
    expect(detectSentenceLength(input)).toEqual([]);
  });

  it('recognises "so" as a split conjunction', () => {
    // Kills CONJUNCTIONS 'so' -> "".
    const input = `${repeatWord('alpha', 20)} so ${repeatWord('beta', 20)}.`;
    const out = detectSentenceLength(input);
    expect(out).toHaveLength(1);
    expect(out[0].original).toBe(' so beta');
  });

  it('recognises "which" as a split conjunction', () => {
    // Kills CONJUNCTIONS 'which' -> "".
    const input = `${repeatWord('alpha', 20)} which ${repeatWord('beta', 20)}.`;
    const out = detectSentenceLength(input);
    expect(out).toHaveLength(1);
    expect(out[0].original).toBe(' which beta');
  });

  it('prefers the conjunction nearest the true midpoint, not the last one', () => {
    // Kills `totalWords / 2` -> `* 2` and `if (!best || dist < best.dist)`
    // -> true: with two conjunctions, the one nearer the real midpoint wins.
    const input = `${repeatWord('a', 19)} and ${repeatWord('b', 14)} but ${repeatWord('c', 14)}.`;
    const out = detectSentenceLength(input);
    expect(out).toHaveLength(1);
    expect(out[0].original).toBe(' and b');
  });

  it('keeps the first conjunction when two are equidistant from the midpoint', () => {
    // Kills the `<` -> `<=` tie-break: equal distances must not replace `best`.
    const input = `${repeatWord('a', 15)} and ${repeatWord('b', 10)} but ${repeatWord('c', 14)}.`;
    const out = detectSentenceLength(input);
    expect(out).toHaveLength(1);
    expect(out[0].original).toBe(' and b');
  });

  it('measures clause balance only to the LEFT of the conjunction', () => {
    // Kills `text.slice(0, absStart)` -> `text`: an unbalanced "(" that appears
    // AFTER the conjunction must not lower the confidence.
    const input = `${repeatWord('alpha', 20)} and ${repeatWord('beta', 10)} ( ${repeatWord('gamma', 10)}.`;
    const out = detectSentenceLength(input);
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe(1.0);
  });

  it('treats a CLOSED paren pair to the left as balanced (confidence 1.0)', () => {
    // Kills the `)` handling: `else if (ch === ')')` -> false, ')' -> "",
    // and `paren--` -> `paren++`. A balanced "(aside)" must not be mid-clause.
    const input = `${repeatWord('alpha', 15)} (aside) ${repeatWord('gamma', 14)} and ${repeatWord('beta', 15)}.`;
    const out = detectSentenceLength(input);
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe(1.0);
  });

  it('suppresses a suggestion whose split point lies in an excluded range', () => {
    // Kills `if (spanIsExcluded(...)) continue` -> false.
    const input = `${repeatWord('alpha', 20)} and ${repeatWord('beta', 20)}.`;
    expect(detectSentenceLength(input, [[0, input.length]])).toEqual([]);
    // Sanity: without the exclusion it IS flagged.
    expect(detectSentenceLength(input)).toHaveLength(1);
  });

  it("derives the suggestion id from the 'sentence_length' category", () => {
    // Kills `makeId('sentence_length', ...)` -> `makeId('', ...)`.
    const input = `${repeatWord('alpha', 20)} and ${repeatWord('beta', 20)}.`;
    const out = detectSentenceLength(input);
    expect(out).toHaveLength(1);
    const s = out[0];
    expect(s.id).toBe(makeId('sentence_length', s.startIndex, s.endIndex, s.original));
  });
});
