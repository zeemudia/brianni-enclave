import type { StyleSuggestion } from '../types';
import { makeId } from '../id';
import { getExcludedRanges, spanIsExcluded, type ExcludedRange } from '../exclusions';
import FILLERS_JSON from '../dictionaries/fillers.json';

type FillerContext = 'sentence_start' | 'after_comma';

interface FillerEntry {
  word: string;
  contexts: FillerContext[];
  confidence: number;
}

const ENTRIES: readonly FillerEntry[] = FILLERS_JSON as readonly FillerEntry[];

function escapeRegex(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a single alternation that catches every filler word/phrase.
 * Case-insensitive because sentence-start forms will be capitalised.
 */
const WORD_ALT = ENTRIES.map((e) => escapeRegex(e.word)).join('|');

/**
 * Sentence-start pattern: (^|[.!?]\s+) <Filler>(, \s+| \s+)
 * - Captures trailing ", " OR a single space so that removal does not leave
 *   a stranded comma or double-space.
 *
 * NOTE: JavaScript RegExp has no lookbehind on some legacy engines; Hermes
 * supports `(?<=...)` since Hermes 0.12, but using a capture group keeps
 * behaviour deterministic across every target.
 */
const SENTENCE_START_RE = new RegExp(
  `(^|[.!?]\\s+)(${WORD_ALT})(,\\s+|\\s+)`,
  'gi',
);

/**
 * After-comma pattern: ", " <Filler>(, | ) — captures the leading ", " and a
 * trailing ", " or " " so the removal reads cleanly.
 */
const AFTER_COMMA_RE = new RegExp(
  `(,\\s+)(${WORD_ALT})(,\\s+|\\s+)`,
  'gi',
);

/**
 * Lookup: word (lowercased) -> entry. Used to decide which contexts apply
 * for a matched word.
 */
const BY_WORD: ReadonlyMap<string, FillerEntry> = new Map(
  ENTRIES.map((e) => [e.word.toLowerCase(), e]),
);

interface RawMatch {
  startIndex: number;
  endIndex: number;
  original: string;
  confidence: number;
}

function runSentenceStart(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  SENTENCE_START_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SENTENCE_START_RE.exec(text)) !== null) {
    const leader = m[1]; // "" at start-of-text, or "<punct>\s+".
    const word = m[2];
    const trailer = m[3];
    const entry = BY_WORD.get(word.toLowerCase());
    if (!entry) continue;
    if (!entry.contexts.includes('sentence_start')) continue;
    const startIndex = m.index + leader.length;
    const original = word + trailer;
    const endIndex = startIndex + original.length;
    out.push({ startIndex, endIndex, original, confidence: entry.confidence });
  }
  return out;
}

function runAfterComma(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  AFTER_COMMA_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AFTER_COMMA_RE.exec(text)) !== null) {
    const leader = m[1]; // ", " (or ",\s+").
    const word = m[2];
    const entry = BY_WORD.get(word.toLowerCase());
    if (!entry) continue;
    if (!entry.contexts.includes('after_comma')) continue;
    // Consume the leading ", " AND the filler word. Leave the trailer so the
    // rest of the sentence keeps its natural boundary (comma or space).
    const startIndex = m.index;
    const original = leader + word;
    const endIndex = startIndex + original.length;
    out.push({ startIndex, endIndex, original, confidence: entry.confidence });
  }
  return out;
}

/**
 * Detect filler words/phrases for removal. Confidence 0.8 per dictionary.
 *
 * Emits a StyleSuggestion with `replacement: ''`. Deduplicates overlapping
 * sentence-start and after-comma hits by preferring sentence-start.
 */
export function detectFillers(
  text: string,
  excluded?: ReadonlyArray<ExcludedRange>,
): StyleSuggestion[] {
  const ranges = excluded ?? getExcludedRanges(text);
  const raw = [...runSentenceStart(text), ...runAfterComma(text)].filter(
    (m) => !spanIsExcluded(m.startIndex, m.endIndex, ranges),
  );
  // Deduplicate: keep the longest suggestion at each start index.
  const byStart = new Map<number, RawMatch>();
  for (const m of raw) {
    const existing = byStart.get(m.startIndex);
    if (!existing || m.endIndex > existing.endIndex) {
      byStart.set(m.startIndex, m);
    }
  }
  return Array.from(byStart.values()).map((m) => ({
    id: makeId('filler', m.startIndex, m.endIndex, m.original),
    category: 'filler',
    original: m.original,
    replacement: '',
    startIndex: m.startIndex,
    endIndex: m.endIndex,
    confidence: m.confidence,
  }));
}
