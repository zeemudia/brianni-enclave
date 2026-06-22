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
  // Stryker disable next-line ConditionalExpression: equivalent — forcing this
  // guard false only skips an early `return []` for empty input. With no items,
  // `[].map(...).sort(...)` is [], the accept loop over [] does nothing, and the
  // final `[].sort(...)` returns []. resolveOverlaps([]) === [] either way.
  if (suggestions.length === 0) return [];

  const indexed = suggestions.map((s, i) => ({ s, i }));
  indexed.sort((a, b) => {
    const pa = CATEGORY_PRIORITY[a.s.category];
    const pb = CATEGORY_PRIORITY[b.s.category];
    if (pa !== pb) return pa - pb;
    // Stryker disable next-line ConditionalExpression: equivalent — forcing this
    // guard true makes the comparator return `startIndex - startIndex` (= 0) for
    // same-startIndex pairs instead of the `a.i - b.i` tertiary tie-break.
    // `indexed` is built ascending in `i` (map index), and Array.prototype.sort
    // is stable (ES2019+), so returning 0 for an equal-key pair preserves the
    // same ascending-`i` order the tie-break would impose. No observable change.
    if (a.s.startIndex !== b.s.startIndex) return a.s.startIndex - b.s.startIndex;
    // Stryker disable next-line ArithmeticOperator: equivalent — `a.i + b.i`
    // vs `a.i - b.i` is reached only for (priority, startIndex)-tied pairs, which
    // form an ascending-`i` subsequence (i = map index). V8 invokes this only as
    // predecessor comparisons (a.i > b.i ≥ 0), where both `a.i - b.i` and
    // `a.i + b.i` are strictly positive — identical sign, identical decision. A
    // divergence would need an `a.i < b.i` call, which a stable sort over an
    // already-ascending-`i` run never makes. The earliest-input element wins
    // under both; output is unchanged.
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
