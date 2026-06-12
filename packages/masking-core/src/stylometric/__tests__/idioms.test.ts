import { describe, it, expect } from 'vitest';
import { detectIdioms } from '../rules/idioms';

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
