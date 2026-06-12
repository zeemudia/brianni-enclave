import type { StyleSuggestion } from '../types';
import { makeId } from '../id';
import { getExcludedRanges, spanIsExcluded, type ExcludedRange } from '../exclusions';
import CONTRACTIONS_JSON from '../dictionaries/contractions.json';

interface ContractionEntry {
  from: string;
  to: string;
}

const ENTRIES: readonly ContractionEntry[] = CONTRACTIONS_JSON as readonly ContractionEntry[];

function escapeRegex(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compiled once at module load. Word-boundary `\b` on BOTH sides so that
 * contractions inside longer words (e.g. "scant'ly") are not matched.
 *
 * The `i` flag lets us catch "Can't" as well as "can't"; we preserve the
 * original case by inspecting the first character of the match and
 * re-capitalising the replacement accordingly.
 */
const COMPILED: ReadonlyArray<{ regex: RegExp; to: string; from: string }> = ENTRIES.map(
  (entry) => ({
    from: entry.from,
    to: entry.to,
    regex: new RegExp(`\\b${escapeRegex(entry.from)}\\b`, 'gi'),
  }),
);

function capitaliseFirst(word: string): string {
  if (word.length === 0) return word;
  return word[0].toUpperCase() + word.slice(1);
}

/**
 * Detect contraction expansions. Confidence is always 1.0.
 */
export function detectContractions(
  text: string,
  excluded?: ReadonlyArray<ExcludedRange>,
): StyleSuggestion[] {
  const ranges = excluded ?? getExcludedRanges(text);
  const out: StyleSuggestion[] = [];
  for (const { regex, to } of COMPILED) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const original = match[0];
      const startIndex = match.index;
      const endIndex = startIndex + original.length;
      if (spanIsExcluded(startIndex, endIndex, ranges)) continue;
      const firstChar = original[0];
      const replacement =
        firstChar && firstChar === firstChar.toUpperCase() && firstChar !== firstChar.toLowerCase()
          ? capitaliseFirst(to)
          : to;
      out.push({
        id: makeId('contraction', startIndex, endIndex, original),
        category: 'contraction',
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
