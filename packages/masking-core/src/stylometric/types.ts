/**
 * Stylometric normalisation engine types.
 *
 * The engine emits `StyleSuggestion` objects describing rule-based rewrites
 * that reduce stylometric fingerprints before a message is sent to the LLM
 * provider. Suggestions are deterministic and cross-platform parity-safe:
 * the same input must produce byte-identical output on Hermes (mobile) and
 * V8 (web).
 */

export type StyleCategory =
  | 'punctuation'
  | 'contraction'
  | 'case'
  | 'filler'
  | 'idiom'
  | 'sentence_length';

export interface StyleSuggestion {
  /** 16-char sha256 hex prefix of `${category}:${start}:${end}:${original}`. */
  id: string;
  category: StyleCategory;
  /** The exact substring matched in the source text. */
  original: string;
  /** Replacement string. Empty string means "remove". */
  replacement: string;
  /** UTF-16 code-unit start index in the source text (inclusive). */
  startIndex: number;
  /** UTF-16 code-unit end index in the source text (exclusive). */
  endIndex: number;
  /** Engine confidence. Default 1.0; fillers default 0.8; split-mid-clause 0.7. */
  confidence: number;
}

/**
 * Priority order for overlap resolution. Lower number = higher priority.
 * When two suggestions overlap, the one with the lower priority wins.
 */
export const CATEGORY_PRIORITY: Record<StyleCategory, number> = {
  punctuation: 1,
  case: 2,
  contraction: 3,
  filler: 4,
  idiom: 5,
  sentence_length: 6,
};
