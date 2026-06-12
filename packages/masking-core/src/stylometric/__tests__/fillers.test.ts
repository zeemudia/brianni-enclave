import { describe, it, expect } from 'vitest';
import { detectFillers } from '../rules/fillers';

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
});
