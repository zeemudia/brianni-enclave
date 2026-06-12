import { describe, it, expect } from 'vitest';
import { analyseStyle, applyAccepted } from '../index';

describe('analyseStyle — integration', () => {
  it('returns an array ordered by startIndex with no overlaps', () => {
    const input = "Basically, I can't believe it!!! It's a game-changer.";
    const out = analyseStyle(input);
    expect(out.length).toBeGreaterThan(0);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].startIndex).toBeGreaterThanOrEqual(out[i - 1].startIndex);
      // Non-overlapping (adjacent allowed).
      expect(out[i].startIndex).toBeGreaterThanOrEqual(out[i - 1].endIndex);
    }
  });

  it('produces deterministic output for the same input', () => {
    const input = "Honestly, we've gotta touch base about the !!!plan.";
    const a = analyseStyle(input);
    const b = analyseStyle(input);
    expect(a).toEqual(b);
  });

  it('applyAccepted applies suggestions right-to-left, yielding the expected string', () => {
    const input = "Basically, I can't wait!!!";
    const suggestions = analyseStyle(input);
    const result = applyAccepted(input, suggestions);
    // After accepting: leading "Basically, " removed; "can't" -> "cannot"; "!!!" -> "!"
    expect(result).toBe('I cannot wait!');
  });

  it('returns empty array for vacuous input', () => {
    expect(analyseStyle('')).toEqual([]);
  });
});

describe('analyseStyle — mixed 200-word fixture', () => {
  it('detects multiple categories and applyAccepted yields a well-formed string', () => {
    const body = [
      "Basically, I can't tell you how excited we are about the new release!!!",
      "It's literally a game-changer for the team.",
      "We are LOVING the new dashboard because it helps us move the needle on key metrics.",
      "Honestly, the API has been rock solid.",
      "At the end of the day, going forward we should touch base weekly.",
      "I don't think we've ever had this kind of momentum before???",
      "Really, it's a no-brainer to ship this!",
    ].join(' ');
    const out = analyseStyle(body);
    expect(out.length).toBeGreaterThan(5);

    const categories = new Set(out.map((s) => s.category));
    expect(categories.has('punctuation')).toBe(true);
    expect(categories.has('contraction')).toBe(true);
    expect(categories.has('idiom')).toBe(true);

    const applied = applyAccepted(body, out);
    expect(applied).not.toContain('!!!');
    expect(applied).not.toContain('???');
    expect(applied).not.toContain("can't");
    // Applied text should be shorter or equal in perceived noise; at minimum,
    // non-empty and different from input.
    expect(applied).not.toBe(body);
    expect(applied.length).toBeGreaterThan(0);
  });
});

describe('analyseStyle — options', () => {
  it('skipSentenceLengthIfOver skips the sentence-length rule when word count exceeds the threshold', () => {
    // Long single sentence (> 40 words, contains a conjunction). This would
    // normally produce a sentence_length suggestion. With a low threshold
    // passed via the option, the rule is skipped entirely.
    const longSentence =
      'alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha and beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta.';
    const withoutOpt = analyseStyle(longSentence);
    const withOpt = analyseStyle(longSentence, { skipSentenceLengthIfOver: 10 });
    const slWithout = withoutOpt.filter((s) => s.category === 'sentence_length');
    const slWith = withOpt.filter((s) => s.category === 'sentence_length');
    expect(slWithout.length).toBeGreaterThan(0);
    expect(slWith.length).toBe(0);
  });
});

describe('analyseStyle — perf budget', () => {
  it('completes a 500-word input within 50ms (soft-asserted outside CI)', () => {
    const sentence =
      "Basically, I can't believe we've gotta touch base again, because it's a game-changer for the team";
    const corpus = Array.from({ length: 10 }, () => sentence).join(' ');
    // ~22 words per sentence * 10 repetitions ~= 220 words; pad out to >= 500.
    const padded = corpus + ' ' + Array.from({ length: 300 }, () => 'word').join(' ');
    const t0 = performance.now();
    const out = analyseStyle(padded);
    const elapsed = performance.now() - t0;
    expect(out.length).toBeGreaterThan(0);
    if (!process.env.CI) {
      expect(elapsed).toBeLessThan(50);
    }
  });
});
