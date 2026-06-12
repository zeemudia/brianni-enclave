import { describe, expect, it } from 'vitest';

import { parseStrictJsonFromModelText } from '../dream/parse-json';

/*
 * Regression coverage for the dream JSON parser. A throw here surfaces as a
 * dream-path TEE_ERROR (see dream/extract.ts:parseCandidateMemories and
 * dream/reconcile.ts), which is the exact failure mode that blocked the
 * streaming-overhead SLO smoke (LAUNCH.md item 2). These cases pin the
 * markdown-fence handling introduced in 734bbbfa so it can't silently regress.
 */
describe('parseStrictJsonFromModelText', () => {
  it('parses bare JSON with no fence', () => {
    expect(parseStrictJsonFromModelText('{"candidates":[]}')).toEqual({
      candidates: [],
    });
  });

  it('parses a bare JSON array (dream extract shape)', () => {
    expect(parseStrictJsonFromModelText('[{"text":"a"},{"text":"b"}]')).toEqual([
      { text: 'a' },
      { text: 'b' },
    ]);
  });

  it('strips a ```json fenced block', () => {
    const text = '```json\n{"candidates":[{"text":"x"}]}\n```';
    expect(parseStrictJsonFromModelText(text)).toEqual({
      candidates: [{ text: 'x' }],
    });
  });

  it('strips a plain ``` fence with no language tag', () => {
    expect(parseStrictJsonFromModelText('```\n[1,2,3]\n```')).toEqual([1, 2, 3]);
  });

  it('treats the language tag case-insensitively', () => {
    expect(parseStrictJsonFromModelText('```JSON\n{"ok":true}\n```')).toEqual({
      ok: true,
    });
  });

  it('tolerates leading/trailing whitespace around the whole payload', () => {
    expect(parseStrictJsonFromModelText('  \n\t{"a":1}\n  ')).toEqual({ a: 1 });
  });

  it('tolerates CRLF line endings around a fenced block', () => {
    expect(parseStrictJsonFromModelText('```json\r\n{"a":1}\r\n```')).toEqual({
      a: 1,
    });
  });

  it('tolerates trailing whitespace after the language tag', () => {
    expect(parseStrictJsonFromModelText('```json  \n{"a":1}\n```')).toEqual({
      a: 1,
    });
  });

  it('throws on non-JSON garbage so callers map it to a parse error', () => {
    expect(() => parseStrictJsonFromModelText('not json at all')).toThrow();
  });

  /*
   * Known limitation, pinned intentionally: the fence regex is anchored to the
   * whole trimmed payload, so a model that wraps the fence in prose
   * ("Here is the JSON:\n```json...") is NOT stripped and currently throws.
   * The dream prompts instruct JSON-only output, so this is acceptable for
   * launch — but if a provider starts emitting prose, this is the line to
   * relax, deliberately.
   */
  it('does NOT strip a fence embedded in surrounding prose (current limitation)', () => {
    const text = 'Here is the JSON:\n```json\n{"a":1}\n```';
    expect(() => parseStrictJsonFromModelText(text)).toThrow();
  });
});
