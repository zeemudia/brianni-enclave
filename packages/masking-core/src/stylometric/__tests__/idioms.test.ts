import { describe, it, expect } from 'vitest';
import { detectIdioms } from '../rules/idioms';
import { makeId } from '../id';

describe('idioms rule', () => {
  it('replaces "game-changer" with "significant improvement"', () => {
    const input = 'It is a game-changer';
    const out = detectIdioms(input);
    expect(out).toHaveLength(1);
    expect(out[0].original).toBe('game-changer');
    expect(out[0].replacement).toBe('significant improvement');
    expect(out[0].category).toBe('idiom');
  });

  it('replaces "no-brainer" with "obvious choice"', () => {
    const input = "it's a no-brainer";
    const out = detectIdioms(input);
    expect(out).toHaveLength(1);
    expect(out[0].original).toBe('no-brainer');
    expect(out[0].replacement).toBe('obvious choice');
  });

  it('replaces "at the end of the day" with "ultimately"', () => {
    const input = 'At the end of the day, we won';
    const out = detectIdioms(input);
    expect(out).toHaveLength(1);
    expect(out[0].original.toLowerCase()).toBe('at the end of the day');
    expect(out[0].replacement).toBe('ultimately');
  });

  it('returns empty array when no idioms are present', () => {
    const input = 'Just a normal sentence without any idioms.';
    const out = detectIdioms(input);
    expect(out).toEqual([]);
  });

  it('all idiom suggestions have confidence 1.0', () => {
    const input = 'It is a game-changer and a no-brainer';
    const out = detectIdioms(input);
    for (const s of out) {
      expect(s.confidence).toBe(1.0);
    }
  });
});

describe('idioms rule — mutation hardening', () => {
  it('spans the whole matched idiom (endIndex = startIndex + length)', () => {
    // Kills `startIndex + original.length` -> `startIndex - original.length`.
    const input = 'we should circle back tomorrow';
    const out = detectIdioms(input);
    const hit = out.find((s) => s.original === 'circle back');
    expect(hit).toBeDefined();
    expect(hit!.endIndex).toBe(hit!.startIndex + hit!.original.length);
    expect(input.slice(hit!.startIndex, hit!.endIndex)).toBe('circle back');
  });

  it('does not rewrite an idiom whose span is excluded', () => {
    // Kills `if (spanIsExcluded(...)) continue` -> false. "circle back" is at [0,11).
    expect(detectIdioms('circle back to me', [[0, 11]])).toEqual([]);
    expect(detectIdioms('circle back to me')).toHaveLength(1);
  });

  it("derives the suggestion id from the 'idiom' category", () => {
    // Kills `makeId('idiom', ...)` -> `makeId('', ...)`.
    const out = detectIdioms('that is a no-brainer');
    const hit = out.find((s) => s.original === 'no-brainer')!;
    expect(hit.id).toBe(makeId('idiom', hit.startIndex, hit.endIndex, hit.original));
  });
});
