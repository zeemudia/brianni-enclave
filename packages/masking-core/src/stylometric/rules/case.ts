import type { StyleSuggestion } from '../types';
import { makeId } from '../id';
import { getExcludedRanges, spanIsExcluded, type ExcludedRange } from '../exclusions';

/**
 * Acronyms that should remain ALL-CAPS even when they look like emphatic
 * shouting. Expanded during the false-positive audit (Task 1.12) if needed.
 */
const ACRONYM_WHITELIST: ReadonlySet<string> = new Set([
  'NHS',
  'USA',
  'UK',
  'US',
  'BBC',
  'CEO',
  'CTO',
  'CFO',
  'COO',
  'API',
  'URL',
  'CSS',
  'HTML',
  'JSON',
  'XML',
  'HTTP',
  'HTTPS',
  'NASA',
  'FBI',
  'CIA',
  'WHO',
  'UN',
  'EU',
  'NATO',
  'AI',
  'ML',
  'LLM',
  'GPU',
  'CPU',
  'RAM',
  'SSD',
  'OS',
  'IDE',
  'SDK',
  'CLI',
  'GUI',
  'SQL',
  'TCP',
  'UDP',
  'DNS',
  'IP',
  'VPN',
  'SSH',
  'TLS',
  'SSL',
  'JWT',
  'PDF',
  'GIF',
  'JPG',
  'PNG',
  'IOS',
  'MAC',
  'PC',
  'UI',
  'UX',
  'FAQ',
  'IMO',
  'IMHO',
  'LOL',
  'OK',
  'TODO',
  'FIXME',
  'NOTE',
  'ECDH',
  'HKDF',
  'KMS',
  'ARN',
  'ORM',
  'REST',
  'RPC',
  'GRPC',
  'AWS',
  'GCP',
  'CDN',
  'MVP',
  'PII',
  'PCR',
  'PCR0',
  'PCR1',
  'PCR2',
  'TEE',
  'SEV',
  'SNP',
  'TPM',
  'PKI',
  'CSR',
  'SAML',
  'OIDC',
  'OAUTH',
  'DPAPI',
  'SRP',
  'GCM',
  'CBC',
  'CTR',
  'IV',
]);

const HONORIFICS: readonly string[] = ['Mr.', 'Dr.', 'Mrs.', 'Ms.', 'Prof.'];

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

function precedingHonorific(text: string, startIndex: number): boolean {
  // Walk back past whitespace.
  let i = startIndex - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0) return false;
  const prefix = text.slice(0, i + 1);
  for (const honorific of HONORIFICS) {
    if (prefix.endsWith(honorific)) return true;
  }
  return false;
}

function isSentenceStart(text: string, startIndex: number): boolean {
  // Sentence-start: first non-whitespace, OR first after ".!?" followed by
  // whitespace.
  let i = startIndex - 1;
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
    if (precedingHonorific(text, startIndex)) continue;

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
