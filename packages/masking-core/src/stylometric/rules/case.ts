import type { StyleSuggestion } from '../types';
import { makeId } from '../id';
import { getExcludedRanges, spanIsExcluded, type ExcludedRange } from '../exclusions';

/**
 * Acronyms that must stay ALL-CAPS even when they look like emphatic shouting.
 *
 * `isAcronym()` below ALSO has a length/vowel heuristic — a word of length <= 3,
 * or with no vowel at all, is treated as an acronym. The whitelist is split into
 * two groups so that relationship (and what each entry is actually worth) is
 * explicit and self-checking:
 *
 *  - {@link HEURISTIC_ESCAPING_ACRONYMS} — length >= 4 AND containing a vowel,
 *    so the heuristic does NOT catch them on its own. The whitelist is
 *    load-bearing here: drop one and the word gets lowercased. That change is
 *    behaviourally observable and is covered by case.test.ts.
 *  - {@link HEURISTIC_REDUNDANT_ACRONYMS} — length <= 3 OR vowelless, so
 *    `isAcronym()` already returns true for them via the heuristic. Listing them
 *    is an explicit, auditable allow-list / defence-in-depth, but removing any
 *    one is behaviourally inert. Each `'X' -> ''` mutation is therefore an
 *    EQUIVALENT mutant (it cannot change any output), which is why the block is
 *    Stryker-disabled. case.test.ts asserts the redundancy invariant so the
 *    equivalence can never silently rot.
 *
 * Expanded during the false-positive audit (Task 1.12) if needed.
 */
export const HEURISTIC_ESCAPING_ACRONYMS: readonly string[] = [
  'JSON', 'NASA', 'NATO', 'IMHO', 'TODO', 'FIXME', 'NOTE', 'ECDH', 'REST',
  'SAML', 'OIDC', 'OAUTH', 'DPAPI',
];

// Stryker disable StringLiteral: equivalent — every entry here is also matched
// by isAcronym()'s length<=3-or-no-vowel heuristic (invariant asserted in
// case.test.ts), so mutating any of these to '' cannot change any output.
export const HEURISTIC_REDUNDANT_ACRONYMS: readonly string[] = [
  'NHS', 'USA', 'UK', 'US', 'BBC', 'CEO', 'CTO', 'CFO', 'COO', 'API', 'URL',
  'CSS', 'HTML', 'XML', 'HTTP', 'HTTPS', 'FBI', 'CIA', 'WHO', 'UN', 'EU', 'AI',
  'ML', 'LLM', 'GPU', 'CPU', 'RAM', 'SSD', 'OS', 'IDE', 'SDK', 'CLI', 'GUI',
  'SQL', 'TCP', 'UDP', 'DNS', 'IP', 'VPN', 'SSH', 'TLS', 'SSL', 'JWT', 'PDF',
  'GIF', 'JPG', 'PNG', 'IOS', 'MAC', 'PC', 'UI', 'UX', 'FAQ', 'IMO', 'LOL',
  'OK', 'HKDF', 'KMS', 'ARN', 'ORM', 'RPC', 'GRPC', 'AWS', 'GCP', 'CDN', 'MVP',
  'PII', 'PCR', 'PCR0', 'PCR1', 'PCR2', 'TEE', 'SEV', 'SNP', 'TPM', 'PKI',
  'CSR', 'SRP', 'GCM', 'CBC', 'CTR', 'IV',
];
// Stryker restore StringLiteral

const ACRONYM_WHITELIST: ReadonlySet<string> = new Set([
  ...HEURISTIC_ESCAPING_ACRONYMS,
  ...HEURISTIC_REDUNDANT_ACRONYMS,
]);

/**
 * Word token matcher. `[A-Z]{2,}` so "I" (single letter) and "Wait" (mixed
 * case) are both skipped.
 */
const ALL_CAPS_WORD = /\b[A-Z]{2,}\b/g;

function hasVowel(word: string): boolean {
  return /[AEIOU]/.test(word);
}

function isAcronym(word: string): boolean {
  if (ACRONYM_WHITELIST.has(word)) return true;
  // Heuristic: length <= 3, OR no vowels (e.g. "BRB", "TMZ") -> likely acronym.
  if (word.length <= 3) return true;
  if (!hasVowel(word)) return true;
  return false;
}

function isSentenceStart(text: string, startIndex: number): boolean {
  // Sentence-start: first non-whitespace, OR first after ".!?" followed by
  // whitespace. A word preceded by an honorific ("Mr. SMITH", "Dr.   SMITH")
  // is also caught here: every honorific ends in '.', so the walk-back lands on
  // that '.' and returns true — which is why no separate honorific check is
  // needed (case.test.ts pins this behaviour).
  let i = startIndex - 1;
  // Stryker disable next-line ConditionalExpression: forcing the `i >= 0` bound
  // true is equivalent — at i === -1, text[i] is undefined and /\s/.test(undefined)
  // is false, so the loop still terminates exactly where the bound would stop it.
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0) return true; // Start of text.
  const prev = text[i];
  if (prev === '.' || prev === '!' || prev === '?') return true;
  return false;
}

/**
 * Detect emphatic ALL-CAPS words that should be lowercased. Confidence 1.0.
 */
export function detectCase(
  text: string,
  excluded?: ReadonlyArray<ExcludedRange>,
): StyleSuggestion[] {
  const ranges = excluded ?? getExcludedRanges(text);
  const out: StyleSuggestion[] = [];
  ALL_CAPS_WORD.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ALL_CAPS_WORD.exec(text)) !== null) {
    const original = match[0];
    const startIndex = match.index;
    const endIndex = startIndex + original.length;

    if (spanIsExcluded(startIndex, endIndex, ranges)) continue;
    if (isAcronym(original)) continue;
    if (isSentenceStart(text, startIndex)) continue;

    const replacement = original.toLowerCase();
    out.push({
      id: makeId('case', startIndex, endIndex, original),
      category: 'case',
      original,
      replacement,
      startIndex,
      endIndex,
      confidence: 1.0,
    });
  }
  return out;
}
