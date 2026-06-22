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
  // Stryker disable next-line StringLiteral: equivalent — no contraction
  // dictionary entry contains a regex metacharacter, so the replacement string
  // is never exercised (the character class never matches) and '\\$&' -> '' is
  // behaviourally inert.
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
  // Stryker disable next-line all: defensive empty-string guard — capitaliseFirst
  // is only ever called with a non-empty dictionary expansion, so this branch is
  // unreachable and its mutants are equivalent (kept to avoid word[0] === undefined).
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
      // Preserve the original leading case. Every contraction begins with a
      // letter, so "did the writer capitalise it?" reduces to a single check:
      // an upper-case letter differs from its own lower-casing. (The earlier
      // triple-guard — truthy AND === toUpperCase() AND !== toLowerCase() — was
      // redundant for cased letters and only produced equivalent mutants.)
      const firstChar = original[0];
      const replacement =
        firstChar !== firstChar.toLowerCase() ? capitaliseFirst(to) : to;
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
