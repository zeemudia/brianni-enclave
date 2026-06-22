import { describe, it, expect } from 'vitest';
import { detectFillers } from '../rules/fillers';
import { makeId } from '../id';
import FILLERS_JSON from '../dictionaries/fillers.json';

describe('fillers rule', () => {
  it('removes a sentence-start filler followed by ", "', () => {
    const input = "Seriously, it's great";
    const out = detectFillers(input);
    expect(out).toHaveLength(1);
    expect(out[0].original).toBe('Seriously, ');
    expect(out[0].replacement).toBe('');
    expect(out[0].category).toBe('filler');
    expect(out[0].confidence).toBe(0.8);
    expect(out[0].startIndex).toBe(0);
    expect(out[0].endIndex).toBe(11);
  });

  it('removes a sentence-start filler without comma (consumes trailing space)', () => {
    const input = 'Basically the idea is good';
    const out = detectFillers(input);
    expect(out).toHaveLength(1);
    expect(out[0].original).toBe('Basically ');
    expect(out[0].replacement).toBe('');
    expect(out[0].startIndex).toBe(0);
    expect(out[0].endIndex).toBe(10);
  });

  it('does NOT remove mid-sentence filler words', () => {
    const input = 'She said it seriously';
    const out = detectFillers(input);
    expect(out).toEqual([]);
  });

  it('removes an after-comma filler including the comma', () => {
    const input = 'It is good, honestly, it is';
    const out = detectFillers(input);
    // Expect one suggestion covering ", honestly," or similar after-comma form.
    expect(out.length).toBeGreaterThanOrEqual(1);
    // The output should strictly reduce visible noise without leaving dangling
    // spaces; we just assert that at least one filler was detected.
    const hit = out.find((s) => s.original.includes('honestly'));
    expect(hit).toBeDefined();
    expect(hit?.replacement).toBe('');
  });

  it('confidence is 0.8 for every filler suggestion', () => {
    const out = detectFillers('Basically the thing is');
    for (const s of out) {
      expect(s.confidence).toBe(0.8);
    }
  });

  describe('Appendix B coverage', () => {
    it.each([
      ['Essentially, this is fine', 'Essentially, '],
      ['Simply, we ship it', 'Simply, '],
      ['Truly, we mean it', 'Truly, '],
      ['In fact, we shipped', 'In fact, '],
      ['Of course, we agree', 'Of course, '],
      ['Needless to say, it worked', 'Needless to say, '],
      ['At any rate, let us move on', 'At any rate, '],
    ])('removes sentence-start filler: %s', (input, expectedOriginal) => {
      const out = detectFillers(input);
      const hit = out.find((s) => s.original === expectedOriginal);
      expect(hit).toBeDefined();
      expect(hit?.replacement).toBe('');
      expect(hit?.startIndex).toBe(0);
    });

    it('removes after-comma "in fact"', () => {
      const input = 'It works, in fact, it thrives';
      const out = detectFillers(input);
      const hit = out.find((s) => s.original.includes('in fact'));
      expect(hit).toBeDefined();
      expect(hit?.replacement).toBe('');
    });

    it('does NOT remove mid-sentence "essentially" / "simply" / "truly"', () => {
      expect(detectFillers('The two are essentially the same')).toEqual([]);
      expect(detectFillers('We simply forgot')).toEqual([]);
      expect(detectFillers('They truly believed it')).toEqual([]);
    });

    it('does NOT match "in fact" mid-sentence without a comma', () => {
      const input = 'We knew in fact that it worked';
      const out = detectFillers(input);
      // "in fact" has no comma-leader here, so no match.
      expect(out.find((s) => s.original.includes('in fact'))).toBeUndefined();
    });
  });

  describe('mutation hardening', () => {
    it('does not remove "so" after a comma (it lacks the after_comma context)', () => {
      // "so" is sentence_start-only in the dictionary. Kills the after-comma
      // context guard `if (!entry.contexts.includes('after_comma')) continue`
      // -> false (which would wrongly strip ", so").
      const out = detectFillers('I agree, so it goes');
      expect(out.find((s) => s.original.includes('so'))).toBeUndefined();
    });

    it('computes a correct span for a sentence-start filler after punctuation', () => {
      // Kills `m.index + leader.length` -> `-` in runSentenceStart: the span
      // must point at the filler itself, not before it.
      const input = 'Done. Actually it works';
      const out = detectFillers(input);
      const hit = out.find((s) => s.original.startsWith('Actually'))!;
      expect(input.slice(hit.startIndex, hit.endIndex)).toBe(hit.original);
      expect(hit.startIndex).toBe(input.indexOf('Actually'));
    });

    it('computes a correct span for an after-comma filler', () => {
      // Kills `startIndex + original.length` -> `-` in runAfterComma.
      const input = 'it works, actually it does';
      const out = detectFillers(input);
      const hit = out.find((s) => s.original.includes('actually'))!;
      expect(input.slice(hit.startIndex, hit.endIndex)).toBe(hit.original);
    });

    it('drops a filler whose span is excluded', () => {
      // Kills the `.filter((m) => !spanIsExcluded(...))` removal: "Actually "
      // spans [0,9); excluding it must suppress the suggestion.
      expect(detectFillers('Actually it works', [[0, 9]])).toEqual([]);
      expect(detectFillers('Actually it works')).toHaveLength(1);
    });

    it("derives the suggestion id from the 'filler' category", () => {
      // Kills `makeId('filler', ...)` -> `makeId('', ...)`.
      const out = detectFillers('Honestly, it works');
      expect(out).toHaveLength(1);
      const s = out[0];
      expect(s.id).toBe(makeId('filler', s.startIndex, s.endIndex, s.original));
    });

    it('every filler entry declares the sentence_start context (equivalence invariant)', () => {
      // Guards the `if (!entry.contexts.includes('sentence_start')) continue`
      // sentence-start guard in runSentenceStart. That mutant is EQUIVALENT only
      // because no dictionary entry omits 'sentence_start'; this invariant pins
      // that fact so the equivalence can never silently rot. If a future entry
      // drops 'sentence_start', this test fails and the disable must be removed
      // and replaced with a behavioural test.
      for (const entry of FILLERS_JSON as Array<{ word: string; contexts: string[] }>) {
        expect(entry.contexts, `entry "${entry.word}"`).toContain('sentence_start');
      }
    });

    it('lazily builds the word lookup so every matched word resolves to its entry', () => {
      // Exercises the lazy getByWord() map-builder (`ENTRIES.map((e) => [...])`)
      // through the detect path. The mutant `() => undefined` makes
      // `new Map([undefined, ...])` throw, which this call would surface; the
      // original resolves every matched word's entry, emitting the suggestion.
      const out = detectFillers('Honestly, it works');
      expect(out).toHaveLength(1);
      expect(out[0].original).toBe('Honestly, ');
      expect(out[0].confidence).toBe(0.8);
    });
  });
});
