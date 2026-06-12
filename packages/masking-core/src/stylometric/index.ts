/**
 * Stylometric normalisation engine — entry point.
 *
 * Public surface:
 *   - analyseStyle(text, opts?): StyleSuggestion[]
 *   - applyAccepted(text, accepted): string
 *
 * The engine runs every rule, collects `StyleSuggestion[]`, filters matches
 * inside excluded ranges (code blocks, URLs, quoted strings), and resolves
 * overlaps by category priority. Output is deterministic and sorted by
 * startIndex.
 *
 * `applyAccepted` walks right-to-left so earlier spans' indices remain
 * valid while later spans are replaced.
 */

import type { StyleSuggestion } from './types';
import { getExcludedRanges } from './exclusions';
import { resolveOverlaps } from './resolve-overlaps';
import { detectPunctuation } from './rules/punctuation';
import { detectContractions } from './rules/contractions';
import { detectCase } from './rules/case';
import { detectFillers } from './rules/fillers';
import { detectIdioms } from './rules/idioms';
import { detectSentenceLength } from './rules/sentence-length';

export type { StyleCategory, StyleSuggestion } from './types';
export { CATEGORY_PRIORITY } from './types';

export interface AnalyseStyleOptions {
  /**
   * Above this word count, skip the sentence-length rule entirely to keep
   * the engine inside its perf budget. Default: 2000.
   */
  skipSentenceLengthIfOver?: number;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

export function analyseStyle(
  text: string,
  opts: AnalyseStyleOptions = {},
): StyleSuggestion[] {
  if (text.length === 0) return [];

  const skipSL = opts.skipSentenceLengthIfOver ?? 2000;
  const excluded = getExcludedRanges(text);

  const all: StyleSuggestion[] = [
    ...detectPunctuation(text, excluded),
    ...detectContractions(text, excluded),
    ...detectCase(text, excluded),
    ...detectFillers(text, excluded),
    ...detectIdioms(text, excluded),
  ];

  if (countWords(text) <= skipSL) {
    all.push(...detectSentenceLength(text, excluded));
  }

  return resolveOverlaps(all);
}

/**
 * Apply a set of accepted suggestions to the original text. Suggestions are
 * applied right-to-left so that the start/end indices of yet-to-be-applied
 * suggestions remain valid.
 *
 * Caller is responsible for passing only non-overlapping suggestions (i.e.
 * typically the output of `analyseStyle` minus any user-rejected entries).
 * Overlaps will still produce well-defined output (last span wins) but the
 * result is unlikely to be what the user wanted.
 */
export function applyAccepted(
  text: string,
  accepted: readonly StyleSuggestion[],
): string {
  if (accepted.length === 0) return text;
  const sorted = [...accepted].sort((a, b) => a.startIndex - b.startIndex);
  let out = text;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const s = sorted[i];
    out = out.slice(0, s.startIndex) + s.replacement + out.slice(s.endIndex);
  }
  return out;
}
