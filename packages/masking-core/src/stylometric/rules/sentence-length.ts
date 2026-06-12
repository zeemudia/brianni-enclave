import type { StyleSuggestion } from '../types';
import { makeId } from '../id';
import { getExcludedRanges, spanIsExcluded, type ExcludedRange } from '../exclusions';

const MAX_WORDS = 40;
const CONJUNCTIONS: readonly string[] = ['and', 'but', 'so', 'because', 'which'];

/**
 * Sentence boundaries: runs of `.!?` optionally followed by whitespace.
 * Keeps the terminator with the preceding sentence via a capture group.
 */
const SENTENCE_SPLIT = /([.!?]+)/g;

interface Sentence {
  start: number;
  end: number;
  text: string;
}

function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  let cursor = 0;
  SENTENCE_SPLIT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SENTENCE_SPLIT.exec(text)) !== null) {
    const end = m.index + m[0].length;
    const segment = text.slice(cursor, end);
    if (segment.trim().length > 0) {
      out.push({ start: cursor, end, text: segment });
    }
    cursor = end;
  }
  if (cursor < text.length) {
    const segment = text.slice(cursor);
    if (segment.trim().length > 0) {
      out.push({ start: cursor, end: text.length, text: segment });
    }
  }
  return out;
}

function countWords(segment: string): number {
  const trimmed = segment.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

interface ConjunctionHit {
  /** Absolute index into the original text (start of the leading space). */
  absStart: number;
  /** Absolute index just past the conjunction + trailing space. */
  absEnd: number;
  /** The original captured span ` <conj> <nextWord>`. */
  original: string;
  /** The replacement `. <NextWord>`. */
  replacement: string;
  /** Distance from the sentence midpoint in words. Smaller is better. */
  wordDistanceFromMiddle: number;
  /** True if there are unbalanced open paren/quote to the left. */
  midClause: boolean;
}

/**
 * Find all " <conj> " occurrences in `sentence` and compute the nearest to
 * the middle. Returns `null` if none are found or the resulting split would
 * leave an empty trailing clause.
 */
function findSplitPoint(sentence: Sentence, text: string): ConjunctionHit | null {
  const segment = sentence.text;
  const totalWords = countWords(segment);
  const targetMidWord = totalWords / 2;

  let best: ConjunctionHit | null = null;

  for (const conj of CONJUNCTIONS) {
    const re = new RegExp(`\\s${conj}\\s+(\\S+)`, 'gi');
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(segment)) !== null) {
      // Count words to the left of the match inside the segment.
      const leftText = segment.slice(0, m.index);
      const wordsLeft = countWords(leftText);
      const distance = Math.abs(wordsLeft - targetMidWord);

      const nextWord = m[1];
      // Capitalise the next word's first character.
      const capitalisedNext = nextWord[0].toUpperCase() + nextWord.slice(1);

      // The leading whitespace is 1 char (\\s). We replace ` conj nextWord`
      // with `. Nextword`.
      const original = ` ${conj} ${nextWord}`;
      const replacement = `. ${capitalisedNext}`;
      const absStart = sentence.start + m.index;
      const absEnd = absStart + original.length;

      // Balance check: count unmatched ( [ { " ' to the left.
      const leftOfConj = text.slice(0, absStart);
      const midClause = isMidClause(leftOfConj);

      const candidate: ConjunctionHit = {
        absStart,
        absEnd,
        original,
        replacement,
        wordDistanceFromMiddle: distance,
        midClause,
      };
      if (!best || candidate.wordDistanceFromMiddle < best.wordDistanceFromMiddle) {
        best = candidate;
      }
    }
  }

  return best;
}

/**
 * Heuristic: a conjunction is "mid-clause" if the text to its left has
 * unbalanced open paren, bracket, brace, or unmatched quote.
 */
function isMidClause(leftText: string): boolean {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let doubleQuote = 0;
  for (const ch of leftText) {
    if (ch === '(') paren++;
    else if (ch === ')') paren--;
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket--;
    else if (ch === '{') brace++;
    else if (ch === '}') brace--;
    else if (ch === '"') doubleQuote++;
  }
  return paren > 0 || bracket > 0 || brace > 0 || doubleQuote % 2 === 1;
}

/**
 * Detect sentences > 40 words and suggest splitting them at the nearest
 * middle conjunction. Confidence 1.0; 0.7 when the split point appears
 * mid-clause (inside open paren/quote).
 */
export function detectSentenceLength(
  text: string,
  excluded?: ReadonlyArray<ExcludedRange>,
): StyleSuggestion[] {
  const ranges = excluded ?? getExcludedRanges(text);
  const out: StyleSuggestion[] = [];
  for (const sentence of splitSentences(text)) {
    const words = countWords(sentence.text);
    if (words <= MAX_WORDS) continue;
    const hit = findSplitPoint(sentence, text);
    if (!hit) continue;
    if (spanIsExcluded(hit.absStart, hit.absEnd, ranges)) continue;
    const confidence = hit.midClause ? 0.7 : 1.0;
    out.push({
      id: makeId('sentence_length', hit.absStart, hit.absEnd, hit.original),
      category: 'sentence_length',
      original: hit.original,
      replacement: hit.replacement,
      startIndex: hit.absStart,
      endIndex: hit.absEnd,
      confidence,
    });
  }
  return out;
}
