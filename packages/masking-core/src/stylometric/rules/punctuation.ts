import type { StyleSuggestion } from '../types';
import { makeId } from '../id';
import { getExcludedRanges, spanIsExcluded, type ExcludedRange } from '../exclusions';

interface PunctuationPattern {
  /** Sticky regex (flag `g`) matched against the source text. */
  regex: RegExp;
  /** Replacement string emitted for every match. */
  replacement: string;
}

const PATTERNS: PunctuationPattern[] = [
  // Repeated same-punctuation runs. Match 2+ of the same character.
  { regex: /!{2,}/g, replacement: '!' },
  { regex: /\?{2,}/g, replacement: '?' },
  { regex: /\.{3,}/g, replacement: '.' },
  { regex: /,{2,}/g, replacement: ',' },
  // Single em dash -> "--".
  { regex: /—/g, replacement: '--' },
];

/**
 * Detect punctuation normalisations. Confidence is always 1.0.
 *
 * Does NOT consider exclusions (code blocks, URLs, quotes) — that filtering
 * is applied by the engine entry point after all rules have run (Task 1.9+).
 */
export function detectPunctuation(
  text: string,
  excluded?: ReadonlyArray<ExcludedRange>,
): StyleSuggestion[] {
  const ranges = excluded ?? getExcludedRanges(text);
  const out: StyleSuggestion[] = [];
  for (const { regex, replacement } of PATTERNS) {
    // Reset regex state; PATTERNS arrays are module-level and `g` flag is stateful.
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const original = match[0];
      const startIndex = match.index;
      const endIndex = startIndex + original.length;
      if (spanIsExcluded(startIndex, endIndex, ranges)) continue;
      out.push({
        id: makeId('punctuation', startIndex, endIndex, original),
        category: 'punctuation',
        original,
        replacement,
        startIndex,
        endIndex,
        confidence: 1.0,
      });
    }
  }
  return out;
}
