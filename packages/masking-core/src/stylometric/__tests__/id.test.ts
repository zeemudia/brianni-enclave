import { describe, it, expect } from 'vitest';
import { makeId } from '../id';

/**
 * makeId derives a stable 16-hex-char id from the FULL tuple
 * `${category}:${start}:${end}:${original}`. These tests pin that every
 * component participates (kills the `payload` template -> "" mutant) and that
 * the function is deterministic / cross-platform stable.
 */
describe('makeId', () => {
  it('returns a 16-char lowercase hex id', () => {
    const id = makeId('case', 0, 5, 'HELLO');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for identical inputs', () => {
    expect(makeId('case', 3, 9, 'WORD')).toBe(makeId('case', 3, 9, 'WORD'));
  });

  it('depends on the category', () => {
    expect(makeId('case', 0, 5, 'AB')).not.toBe(makeId('filler', 0, 5, 'AB'));
    expect(makeId('contraction', 0, 5, 'AB')).not.toBe(
      makeId('idiom', 0, 5, 'AB'),
    );
  });

  it('depends on the start index', () => {
    expect(makeId('case', 0, 5, 'AB')).not.toBe(makeId('case', 1, 5, 'AB'));
  });

  it('depends on the end index', () => {
    expect(makeId('case', 0, 5, 'AB')).not.toBe(makeId('case', 0, 6, 'AB'));
  });

  it('depends on the original text', () => {
    expect(makeId('case', 0, 5, 'AB')).not.toBe(makeId('case', 0, 5, 'CD'));
  });

  it('produces distinct ids when only the separator-adjacent fields differ', () => {
    // Guards against a payload that drops one of the colon-joined fields.
    const ids = new Set([
      makeId('case', 1, 2, 'x'),
      makeId('case', 12, 2, 'x'), // start "12" vs "1" + end "2"
      makeId('case', 1, 22, 'x'),
    ]);
    expect(ids.size).toBe(3);
  });
});
