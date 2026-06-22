import { describe, it, expect } from 'vitest';
import {
  detectCase,
  HEURISTIC_ESCAPING_ACRONYMS,
  HEURISTIC_REDUNDANT_ACRONYMS,
} from '../rules/case';
import { makeId } from '../id';

// The full whitelist, sourced directly from case.ts so this corpus stays in
// lockstep with the source (both load-bearing and heuristic-redundant entries).
const acronymWhitelist = [
  ...HEURISTIC_ESCAPING_ACRONYMS,
  ...HEURISTIC_REDUNDANT_ACRONYMS,
];

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

  it('does not flag ALL-CAPS words at the start of text or after sentence punctuation', () => {
    expect(detectCase('LOUD opening, then calm')).toEqual([]);
    expect(detectCase('Done. LOUD opening, then calm')).toEqual([]);
    expect(detectCase('Done!\tLOUD opening, then calm')).toEqual([]);
    expect(detectCase('Done?\nLOUD opening, then calm')).toEqual([]);
  });

  it('does not flag acronyms from the whitelist (NHS, USA, API, ...)', () => {
    const input = 'Visit the NHS or the USA or read the API';
    const out = detectCase(input);
    expect(out).toEqual([]);
  });

  it('treats the full acronym whitelist as a no-suggestion corpus', () => {
    const input = `Use ${acronymWhitelist.join(' ')} in technical prose`;
    const out = detectCase(input);
    expect(out).toEqual([]);
  });

  it('does not flag short acronyms (length <= 3)', () => {
    const input = 'She works at NASA and the UN';
    const out = detectCase(input);
    // "UN" is length 2 => acronym. "NASA" is length 4 but in whitelist.
    expect(out).toEqual([]);
  });

  it('does not flag longer vowelless acronym-like words', () => {
    const input = 'The BRRR trace was noisy';
    const out = detectCase(input);
    expect(out).toEqual([]);
  });

  it('does not flag words preceded by honorifics (Mr., Dr., Mrs., Ms., Prof.)', () => {
    // Honorifics all end in '.', so the all-caps word is a sentence-start by the
    // isSentenceStart walk-back and is skipped — no dedicated honorific check.
    const input = 'Mr. SMITH is here and Dr. JONES left';
    const out = detectCase(input);
    expect(out).toEqual([]);
  });

  it('walks back across whitespace to the honorific full stop before the word', () => {
    const input = 'The referral says Dr.   SMITH should review it';
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

  it('still flags non-acronym ALL-CAPS words after non-sentence punctuation', () => {
    const input = 'Well, LOUDLY now';
    const out = detectCase(input);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      original: 'LOUDLY',
      replacement: 'loudly',
      startIndex: 6,
      endIndex: 12,
    });
  });

  it('leaves all-caps "I" alone (single character)', () => {
    const input = 'Hello, I am here';
    const out = detectCase(input);
    expect(out).toEqual([]);
  });
});

describe('case rule — mutation hardening', () => {
  it('treats a 3-letter ALL-CAPS word as an acronym even when not whitelisted', () => {
    // Kills the `word.length <= 3` short-acronym rule mutants (-> `< 3`,
    // boolean -> false, condition -> false). "POP"/"ZAP" carry a vowel and are
    // length 3, so ONLY the length rule keeps them from being lowercased.
    expect(detectCase('the POP chart today')).toEqual([]);
    expect(detectCase('we will ZAP it now')).toEqual([]);
  });

  it('flags an ALL-CAPS word when only a single non-space char precedes it', () => {
    // Kills `if (i < 0) return true` -> `i <= 0` in isSentenceStart: a word
    // whose walk-back lands on index 0 (a real char, not start-of-text) is NOT
    // a sentence start and must still be lowercased.
    const out = detectCase('a LOUDER day');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ original: 'LOUDER', replacement: 'louder' });
  });

  it('treats an ALL-CAPS word after only leading whitespace as a sentence start', () => {
    // Kills `while (i >= 0 ...)` -> `i > 0` (and the condition -> true infinite
    // loop) in isSentenceStart: walking back over a leading space must reach
    // index -1 (start of text) so the word is skipped, not lowercased.
    expect(detectCase(' LOUDLY now')).toEqual([]);
  });

  it('never emits a suggestion whose span falls inside an excluded range', () => {
    // Kills `if (spanIsExcluded(...)) continue` -> `false`. "LOUDLY" spans
    // [4, 10); excluding that range must suppress the suggestion.
    expect(detectCase('say LOUDLY now', [[4, 10]])).toEqual([]);
    // Sanity: without the exclusion it IS flagged.
    expect(detectCase('say LOUDLY now')).toHaveLength(1);
  });

  it("derives the suggestion id from the 'case' category, not an empty string", () => {
    // Kills `makeId('case', ...)` -> `makeId('', ...)`: the id is a hash that
    // includes the category, so the literal must be 'case'.
    const out = detectCase('I am LOVING it');
    expect(out).toHaveLength(1);
    const s = out[0];
    expect(s.id).toBe(makeId('case', s.startIndex, s.endIndex, s.original));
  });
});

describe('case rule — acronym whitelist partition', () => {
  const hasVowel = (w: string): boolean => /[AEIOU]/.test(w);

  it('every load-bearing acronym needs the whitelist and is preserved by detectCase', () => {
    // Each escaping acronym is length >= 4 AND has a vowel, so isAcronym()'s
    // length/vowel heuristic does NOT catch it — only the whitelist keeps it
    // upper-case. This kills every `'<acr>' -> ''` mutant in the escaping list:
    // remove the entry and the word would be lowercased.
    expect(HEURISTIC_ESCAPING_ACRONYMS.length).toBeGreaterThan(0);
    for (const acr of HEURISTIC_ESCAPING_ACRONYMS) {
      expect(acr.length >= 4 && hasVowel(acr)).toBe(true);
      // Placed mid-sentence (after "The ") so it is neither a sentence start nor
      // honorific-preceded — the ONLY thing keeping it upper-case is the list.
      expect(detectCase(`The ${acr} team shipped`)).toEqual([]);
    }
  });

  it('every heuristic-redundant acronym is independently caught by the length/vowel heuristic', () => {
    // Equivalence invariant for the Stryker-disabled block: each redundant entry
    // is length <= 3 OR vowelless, so isAcronym() returns true for it even with
    // the entry removed — i.e. mutating it to '' cannot change any output. If
    // this ever fails, an entry was misfiled and its mutant is no longer
    // equivalent; move it into HEURISTIC_ESCAPING_ACRONYMS.
    expect(HEURISTIC_REDUNDANT_ACRONYMS.length).toBeGreaterThan(0);
    for (const acr of HEURISTIC_REDUNDANT_ACRONYMS) {
      expect(acr.length <= 3 || !hasVowel(acr)).toBe(true);
      // And detectCase still leaves it upper-case (via the heuristic).
      expect(detectCase(`The ${acr} team shipped`)).toEqual([]);
    }
  });

  it('the two partitions are disjoint and non-empty', () => {
    const escaping = new Set(HEURISTIC_ESCAPING_ACRONYMS);
    const overlap = HEURISTIC_REDUNDANT_ACRONYMS.filter((a) => escaping.has(a));
    expect(overlap).toEqual([]);
  });
});
