import type { StyleSuggestion } from '../types';
import { makeId } from '../id';
import { getExcludedRanges, spanIsExcluded, type ExcludedRange } from '../exclusions';
import IDIOMS_JSON from '../dictionaries/idioms.json';

interface IdiomEntry {
  from: string;
  to: string;
}

const ENTRIES: readonly IdiomEntry[] = IDIOMS_JSON as readonly IdiomEntry[];

function escapeRegex(raw: string): string {
  // Stryker disable next-line StringLiteral: equivalent — no idiom dictionary
  // entry contains a regex metacharacter, so the replacement string is never
  // exercised (the character class never matches) and '\\$&' -> '' is
  // behaviourally inert.
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build regexes once. Word-boundary on BOTH sides so that substrings inside
 * longer words (e.g. "bandwidthy") are not matched. Case-insensitive, but
 * we emit the original-case substring so the upstream applier can decide.
 */
const COMPILED: ReadonlyArray<{ regex: RegExp; to: string }> = ENTRIES.map((entry) => ({
  to: entry.to,
  regex: new RegExp(`\\b${escapeRegex(entry.from)}\\b`, 'gi'),
}));

/**
 * Detect idiomatic phrases for replacement. Confidence 1.0.
 *
 * Multiple overlapping matches may be emitted across entries (e.g. a
 * compound phrase that contains a shorter idiom). Overlap resolution in
 * `resolve-overlaps.ts` will pick one.
 */
export function detectIdioms(
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
      out.push({
        id: makeId('idiom', startIndex, endIndex, original),
        category: 'idiom',
        original,
        replacement: to,
        startIndex,
        endIndex,
        confidence: 1.0,
      });
    }
  }
  return out;
}
