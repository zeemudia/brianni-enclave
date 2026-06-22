import { describe, expect, it } from 'vitest';

import { parseStrictJsonFromModelText } from '../dream/parse-json';

/*
 * Mutation-hardening supplement for dream/parse-json.ts. Pins the fence regex
 * anchors and the two trims so they can't be silently dropped:
 *   - the outer `text.trim()` (a payload that only parses after trimming),
 *   - the `^...$` anchors (a fence that is NOT the whole payload must NOT be
 *     stripped — anchoring is what makes the "fence-in-prose" case throw),
 *   - the inner `match[1].trim()` (fenced content padded with blank lines).
 */

describe('parseStrictJsonFromModelText anchors + trims', () => {
  it('requires the outer trim: surrounding whitespace around a fence still parses', () => {
    // Without the leading-newline trim before the regex, `^```` would not match.
    const text = '\n\n```json\n{"a":1}\n```\n\n';
    expect(parseStrictJsonFromModelText(text)).toEqual({ a: 1 });
  });

  it('does NOT strip a fence that is only a PREFIX of the payload (end anchor)', () => {
    // A valid fence followed by trailing prose: the `$` anchor means the regex
    // must NOT match, so the whole thing is fed to JSON.parse and throws.
    const text = '```json\n{"a":1}\n```\ntrailing prose after the fence';
    expect(() => parseStrictJsonFromModelText(text)).toThrow();
  });

  it('does NOT strip a fence that is only a SUFFIX of the payload (start anchor)', () => {
    const text = 'leading prose before the fence\n```json\n{"a":1}\n```';
    expect(() => parseStrictJsonFromModelText(text)).toThrow();
  });

  it('trims the captured fenced content (inner trim) so padded JSON still parses', () => {
    // The captured group has leading/trailing spaces inside the fence; the
    // inner `.trim()` is what lets JSON.parse succeed.
    const text = '```json\n   {"a":1}   \n```';
    expect(parseStrictJsonFromModelText(text)).toEqual({ a: 1 });
  });

  it('allows whitespace BETWEEN the fence and the json tag (the [ \\t]* class)', () => {
    // `[ \t]*(?:json)?` permits spaces before `json`. A mutant that changes the
    // pre-tag class to `[^ \t]*` would refuse this and throw; stripping it
    // proves the whitespace-tolerant character class is intact.
    const text = '```  json\n{"a":1}\n```';
    expect(parseStrictJsonFromModelText(text)).toEqual({ a: 1 });
  });
});
