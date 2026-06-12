import type { StyleSuggestion } from './types';
import { CATEGORY_PRIORITY } from './types';

/**
 * Two suggestions overlap iff their open-interval spans intersect. Adjacent
 * spans (a.end === b.start) are NOT overlapping.
 */
function overlaps(a: StyleSuggestion, b: StyleSuggestion): boolean {
  return a.startIndex < b.endIndex && b.startIndex < a.endIndex;
}

/**
 * Resolve overlapping suggestions. Input may contain any mix of categories
 * and spans. Output is non-overlapping, sorted by startIndex.
 *
 * Algorithm:
 *   1. Sort candidates by (priority asc, startIndex asc, input order).
 *   2. Walk left-to-right; accept the current candidate iff it does not
 *      overlap any already-accepted one.
 *   3. Re-sort accepted by startIndex before returning.
 *
 * Ties (same priority + same span) are broken by input order — the first
 * suggestion wins. This is deterministic and stable across platforms.
 */
export function resolveOverlaps(
  suggestions: readonly StyleSuggestion[],
): StyleSuggestion[] {
  if (suggestions.length === 0) return [];

  const indexed = suggestions.map((s, i) => ({ s, i }));
  indexed.sort((a, b) => {
    const pa = CATEGORY_PRIORITY[a.s.category];
    const pb = CATEGORY_PRIORITY[b.s.category];
    if (pa !== pb) return pa - pb;
    if (a.s.startIndex !== b.s.startIndex) return a.s.startIndex - b.s.startIndex;
    return a.i - b.i;
  });

  const accepted: StyleSuggestion[] = [];
  for (const { s } of indexed) {
    const clash = accepted.some((a) => overlaps(a, s));
    if (!clash) accepted.push(s);
  }

  accepted.sort((a, b) => a.startIndex - b.startIndex);
  return accepted;
}
