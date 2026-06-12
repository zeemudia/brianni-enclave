import { describe, it, expect } from 'vitest';
import { getExcludedRanges, isExcluded } from '../exclusions';
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
