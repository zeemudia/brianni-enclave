import { describe, it, expect } from 'vitest';
import { getExcludedRanges, isExcluded, spanIsExcluded } from '../exclusions';
import { detectPunctuation } from '../rules/punctuation';
import { detectContractions } from '../rules/contractions';

describe('getExcludedRanges', () => {
  it('excludes fenced code blocks (triple backtick)', () => {
    const input = 'before ```js\nconst x = 1;\n``` after';
    const ranges = getExcludedRanges(input);
    const fenceStart = input.indexOf('```');
    const fenceEndOpenTick = input.lastIndexOf('```');
    // Middle of fenced content must be excluded.
    const mid = Math.floor((fenceStart + fenceEndOpenTick) / 2);
    expect(isExcluded(mid, ranges)).toBe(true);
    // "before" is outside.
    expect(isExcluded(0, ranges)).toBe(false);
  });

  it('excludes inline code (single backtick pair)', () => {
    const input = 'call `foo!!!` here';
    const ranges = getExcludedRanges(input);
    const idx = input.indexOf('!!!');
    expect(isExcluded(idx, ranges)).toBe(true);
    expect(isExcluded(0, ranges)).toBe(false);
  });

  it('excludes URLs (http/https)', () => {
    const input = 'Visit https://example.com now';
    const ranges = getExcludedRanges(input);
    const urlMid = input.indexOf('example');
    expect(isExcluded(urlMid, ranges)).toBe(true);
  });

  it('excludes double-quoted strings', () => {
    const input = 'He said "don\'t change this!!!"';
    const ranges = getExcludedRanges(input);
    const bangsIdx = input.indexOf('!!!');
    expect(isExcluded(bangsIdx, ranges)).toBe(true);
  });

  it('does not treat an in-word apostrophe as a single-quote string', () => {
    const input = "I don't know";
    const ranges = getExcludedRanges(input);
    const contractionIdx = input.indexOf("don't");
    expect(isExcluded(contractionIdx, ranges)).toBe(false);
  });
});

describe('exclusions propagate to rules', () => {
  it('punctuation rule skips "!!!" inside a double-quoted string', () => {
    const input = 'ok "don\'t change this!!!" done';
    const out = detectPunctuation(input);
    expect(out).toEqual([]);
  });

  it('contractions rule still flags in-text "don\'t"', () => {
    const input = "I don't know";
    const out = detectContractions(input);
    expect(out.length).toBe(1);
    expect(out[0].original).toBe("don't");
  });

  it('punctuation rule skips "!!!" inside fenced code', () => {
    const input = 'before ```alert("!!!")``` after';
    const out = detectPunctuation(input);
    expect(out).toEqual([]);
  });

  it('punctuation rule skips "!!!" inside a URL query string', () => {
    const input = 'visit https://example.com/x?a=!!! now';
    const out = detectPunctuation(input);
    expect(out).toEqual([]);
  });
});

describe('getExcludedRanges — mutation hardening', () => {
  it('returns no ranges for text with nothing to exclude', () => {
    // Kills `const ranges = []` -> `["Stryker was here"]` (junk seed entry).
    expect(getExcludedRanges('a perfectly ordinary sentence')).toEqual([]);
  });

  it('excludes plain http URLs, not only https', () => {
    // Kills the URL regex `https?` -> `https` (would miss bare http).
    const input = 'open http://example.com/x?a=1 here';
    const ranges = getExcludedRanges(input);
    expect(isExcluded(input.indexOf('example'), ranges)).toBe(true);
  });

  it('excludes a single-quoted string and only that span', () => {
    // Kills the single-quote regex mutants (\s before/after, +-drop,
    // lookahead negate) and the start/end arithmetic (m.index ± leadLen).
    const input = "ab 'cd' ef"; // 'cd' occupies [3, 7): "'", c, d, "'".
    const ranges = getExcludedRanges(input);
    expect(isExcluded(input.indexOf('cd'), ranges)).toBe(true); // content
    expect(isExcluded(3, ranges)).toBe(true); // opening quote
    expect(isExcluded(6, ranges)).toBe(true); // closing quote
    expect(isExcluded(2, ranges)).toBe(false); // space before
    expect(isExcluded(7, ranges)).toBe(false); // space after
  });

  it('excludes a single-quoted string at the very start of the text', () => {
    // Kills `(^|\s)` -> `(\s)` (dropping the start-of-text alternative).
    const input = "'stop' now";
    const ranges = getExcludedRanges(input);
    expect(isExcluded(input.indexOf('stop'), ranges)).toBe(true);
  });

  it('does not exclude an apostrophe-bearing contraction as a quoted string', () => {
    expect(isExcluded(2, getExcludedRanges("I don't know"))).toBe(false);
  });

  it('does not double-push an inline-backtick span that lies inside a fenced block', () => {
    // The inline-code scan re-walks the whole text with its own regex, so a
    // single-backtick pair that sits INSIDE a fence (e.g. `` `code ` `` and
    // `` ` more` `` within ```` ```code `inline` more``` ````) is re-matched.
    // The `if (!withinAny(s, ranges))` guard (L33) suppresses those re-matches
    // because the fence already covers them. Kills the guard -> `true` mutant,
    // which would push the two subsumed inline spans, yielding 3 ranges instead
    // of the single fence range. (isExcluded can't see this — the extra spans
    // are subsets of the fence — so we assert on the raw range array.)
    const input = 'pre ```code `inline` more``` post';
    const ranges = getExcludedRanges(input);
    const fenceStart = input.indexOf('```');
    const fenceEnd = input.lastIndexOf('```') + 3;
    expect(ranges).toEqual([[fenceStart, fenceEnd]]);
  });

  it('excludes a single-quoted string that ends the text (closing quote at EOT)', () => {
    // Kills the lookahead `(?=\s|[.,!?;:]|$)` -> drop `|$`: a quoted string with
    // its closing quote at end-of-text (no trailing whitespace/punctuation) must
    // still be excluded.
    const input = "say 'hello'";
    const ranges = getExcludedRanges(input);
    expect(isExcluded(input.indexOf('hello'), ranges)).toBe(true); // content
    expect(isExcluded(input.length - 1, ranges)).toBe(true); // closing quote
    expect(isExcluded(input.indexOf('say'), ranges)).toBe(false); // outside
  });

  it('excludes a single-quoted string immediately followed by punctuation', () => {
    // Kills the lookahead char-class negation `[.,!?;:]` -> `[^.,!?;:]`: a quote
    // closed right before a sentence-ending '.' must still be excluded. Under the
    // negated class that closing-quote-before-'.' case stops matching entirely.
    const input = "he said 'hi'.";
    const ranges = getExcludedRanges(input);
    expect(isExcluded(input.indexOf('hi'), ranges)).toBe(true); // content
    expect(isExcluded(input.indexOf("'"), ranges)).toBe(true); // opening quote
    expect(isExcluded(input.lastIndexOf("'"), ranges)).toBe(true); // closing quote
  });
});

describe('isExcluded / spanIsExcluded — interval boundary semantics', () => {
  it('treats the range as half-open [start, end)', () => {
    // NOTE: `getExcludedRanges` is called INSIDE the test (not in the describe
    // body) on purpose. Calling instrumented source during collection makes
    // Stryker classify those mutants as "static" and, worse, a mutation that
    // breaks the collection-time call poisons the entire file's collection so
    // the real behavioural kill-tests never run -> false "Survived". See
    // docs/quality/mutation-triage/masking-core.md (harness reliability).
    // Build a known range from a URL: [start, end) is half-open.
    const text = 'see https://a.io done';
    const ranges = getExcludedRanges(text);
    const [start, end] = ranges[0];
    // Kills withinAny `index >= start` -> `> start`, `index < end` -> `<= end`,
    // and the `&& index < end` -> true.
    expect(isExcluded(start, ranges)).toBe(true); // start inclusive
    expect(isExcluded(end - 1, ranges)).toBe(true); // last char inside
    expect(isExcluded(end, ranges)).toBe(false); // end exclusive
    expect(isExcluded(start - 1, ranges)).toBe(false); // before start
  });

  it('spanIsExcluded is true only for a real intersection, not adjacency', () => {
    // Kills spanIsExcluded `start < re` -> `<=`, `rs < end` -> `<=`, and -> true.
    expect(spanIsExcluded(2, 8, [[0, 10]])).toBe(true); // overlaps
    expect(spanIsExcluded(10, 15, [[0, 10]])).toBe(false); // touches at 10, no overlap
    expect(spanIsExcluded(0, 5, [[5, 10]])).toBe(false); // touches at 5, no overlap
  });
});
