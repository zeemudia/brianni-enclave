import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { analyseStyle } from '../index';
import { getExcludedRanges, spanIsExcluded } from '../exclusions';

const CORPUS_DIR = join(__dirname, '..', '..', '..', 'fixtures', 'corpus-technical');

function wordCount(text: string): number {
  const t = text.trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

function loadFixtures(): Array<{ name: string; text: string }> {
  const names = readdirSync(CORPUS_DIR).filter((n) => n.endsWith('.txt'));
  return names.map((name) => ({
    name,
    text: readFileSync(join(CORPUS_DIR, name), 'utf8'),
  }));
}

describe('stylometric engine — false-positive corpus', () => {
  const fixtures = loadFixtures();

  it('has at least 5 technical-writing fixtures', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(5);
  });

  for (const { name, text } of fixtures) {
    it(`${name}: false-positive rate is below 5%`, () => {
      const wc = wordCount(text);
      expect(wc).toBeGreaterThan(50);
      const suggestions = analyseStyle(text);
      const rate = suggestions.length / wc;
      expect(rate).toBeLessThan(0.05);
    });

    it(`${name}: no suggestion intersects a code fence or URL range`, () => {
      const excluded = getExcludedRanges(text);
      const suggestions = analyseStyle(text);
      for (const s of suggestions) {
        expect(spanIsExcluded(s.startIndex, s.endIndex, excluded)).toBe(false);
      }
    });
  }
});
