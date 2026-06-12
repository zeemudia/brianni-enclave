/**
 * Excluded ranges. The stylometric engine must not emit suggestions whose
 * span intersects any of these zones, because altering them would change
 * semantics (code, URLs) or violate a direct quotation.
 *
 * Range convention: [start, end) — start inclusive, end exclusive. All
 * indices are UTF-16 code units, matching JavaScript string offsets.
 */
export type ExcludedRange = readonly [number, number];

/**
 * Collect every excluded range in `text` and return them as a flat array.
 * Ranges may overlap; callers MUST NOT assume disjointness. Use
 * `isExcluded(index, ranges)` to test.
 */
export function getExcludedRanges(text: string): ExcludedRange[] {
  const ranges: Array<[number, number]> = [];

  // 1. Fenced code blocks ``` ... ``` (multiline).
  //    Non-greedy to support multiple fences; the lastIndex mechanic advances
  //    past each closing fence.
  const fenceRe = /```[\s\S]*?```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }

  // 2. Inline code `...` (single backtick pair). Skip triple-backtick spans
  //    already covered above by filtering matches that lie inside a fence.
  const inlineRe = /`[^`\n]+`/g;
  while ((m = inlineRe.exec(text)) !== null) {
    const [s, e] = [m.index, m.index + m[0].length];
    if (!withinAny(s, ranges)) ranges.push([s, e]);
  }

  // 3. URLs.
  const urlRe = /https?:\/\/[^\s]+/g;
  while ((m = urlRe.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }

  // 4. Double-quoted strings. A simple, greedy-match-per-line scan — NOT a
  //    full parser. Good enough to exclude the common `"..."` case.
  const doubleQuoteRe = /"[^"\n]*"/g;
  while ((m = doubleQuoteRe.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }

  // 5. Single-quoted strings. Only treat as a quoted string if the opening
  //    quote is preceded by whitespace/start-of-text AND the closing quote
  //    is followed by whitespace, punctuation, or end-of-text. This avoids
  //    flagging apostrophes inside contractions (e.g. "don't").
  const singleQuoteRe = /(^|\s)'([^'\n]+)'(?=\s|[.,!?;:]|$)/g;
  while ((m = singleQuoteRe.exec(text)) !== null) {
    const leadLen = m[1].length;
    const start = m.index + leadLen;
    const end = start + m[0].length - leadLen;
    ranges.push([start, end]);
  }

  return ranges;
}

function withinAny(index: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  for (const [start, end] of ranges) {
    if (index >= start && index < end) return true;
  }
  return false;
}

/**
 * Test whether a given offset is inside any excluded range.
 */
export function isExcluded(index: number, ranges: ReadonlyArray<ExcludedRange>): boolean {
  return withinAny(index, ranges);
}

/**
 * Test whether a span `[start, end)` intersects any excluded range.
 */
export function spanIsExcluded(
  start: number,
  end: number,
  ranges: ReadonlyArray<ExcludedRange>,
): boolean {
  for (const [rs, re] of ranges) {
    if (start < re && rs < end) return true;
  }
  return false;
}
