import type { PIIEntity, PIIPattern } from "./types";

/**
 * PII regex patterns from the technical specification.
 * Runs entirely on-device with zero network dependency.
 */
export const PII_PATTERNS: PIIPattern[] = [
  // Names — triggered by title prefixes, capitalisation patterns
  {
    type: "NAME",
    pattern:
      /\b(?:(?:Dr|Mr|Mrs|Ms|Miss|Prof|Rev)\.?[ \t]+)?[A-Z][a-z\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1]+(?:[ \t]+(?:O'|Mc|Mac)?[A-Z][a-z\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1]+)+\b/g,
    confidence: 0.7,
  },

  // Email addresses
  {
    type: "EMAIL",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    confidence: 0.99,
  },

  // UK phone numbers
  {
    type: "PHONE",
    pattern: /(?:\+44\s?(?:\d\s?){8,9}\d\b|\b0(?:\d\s?){8,9}\d\b)/g,
    confidence: 0.95,
  },

  // US phone numbers
  {
    type: "PHONE",
    pattern: /\b(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    confidence: 0.9,
  },

  // UK postcodes
  {
    type: "ADDR",
    pattern: /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/g,
    confidence: 0.95,
  },

  // US ZIP codes
  {
    type: "ADDR",
    pattern: /\b\d{5}(?:-\d{4})?\b/g,
    confidence: 0.6,
  },

  // NOTE: bare numeric dates (e.g. 2026-06-02, 06/02/2026) are deliberately
  // NOT masked here. A bare calendar date is not high-confidence PII, and
  // unconditional date masking broke the Calypso agent: a scheduling date or
  // a dated filename (report-2026-06-02.md) was masked to [DOB_1], leaving the
  // drafted event/file unusable (live A09 failure). Numeric dates are masked
  // ONLY when they appear in an explicit birth-date context — see
  // NUMERIC_DOB_RE in detectContextualPII below, which mirrors the
  // natural-language NATURAL_DOB_RE.

  // UK National Insurance numbers
  {
    type: "ID",
    pattern:
      /\b[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi,
    confidence: 0.98,
  },

  // US Social Security numbers
  {
    type: "ID",
    pattern: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g,
    confidence: 0.85,
  },

  // Credit card numbers (basic patterns)
  {
    type: "ACCT",
    pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
    confidence: 0.8,
  },
];

const MONTH_NAME =
  "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";
const DOB_CONTEXT = "date of birth|dob|d\\.o\\.b\\.?|born(?: on)?|birthdate|birthday|i was born(?: on)?";
const NATURAL_DOB_RE = new RegExp(
  `\\b(?:${DOB_CONTEXT})\\b[^.\\n]{0,40}?\\b(\\d{1,2}\\s+(?:${MONTH_NAME})\\s+\\d{4})\\b`,
  "gi",
);
// Numeric dates are DOB-masked ONLY in an explicit birth-date context, never
// as bare calendar dates (which the agent must be able to act on). Mirrors
// NATURAL_DOB_RE but for slash/dash/dot numeric date forms.
const NUMERIC_DOB_RE = new RegExp(
  `\\b(?:${DOB_CONTEXT})\\b[^.\\n]{0,40}?\\b(\\d{1,2}[\\/\\-.]\\d{1,2}[\\/\\-.]\\d{2,4}|\\d{4}[\\/\\-.]\\d{1,2}[\\/\\-.]\\d{1,2})\\b`,
  "gi",
);
const PROFILE_HANDLE_RE =
  /\b(?:https?:\/\/)?(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org|twitter\.com|x\.com)\/([A-Za-z0-9](?:[A-Za-z0-9_.-]{0,37}[A-Za-z0-9])?)(?=\/|[\s"'<>)]|$)/gi;
const LINKEDIN_HANDLE_RE =
  /\b(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/([A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?)(?=\/|[\s"'<>)]|$)/gi;
const UNIX_USER_PATH_RE =
  /(^|[^\w/])(\/(?:Users|home)\/[A-Za-z0-9._-]+)(?=\/|$)/g;
const WINDOWS_USER_PATH_RE = /(^|[^\w/])([A-Za-z]:\\Users\\[^\\/\s]+)(?=\\|$)/g;
// Generic job/role/title words. A Title-Case phrase composed ENTIRELY of
// these is a role description ("Senior Product Engineer"), never a person's
// name, so it must not be masked — masking it stranded agent tasks that had
// to reference the role. A real name has at least one non-role token
// ("Jane Okafor", "Senior engineer Jane Okafor"), so it stays masked.
const ROLE_TITLE_WORDS = new Set(
  [
    "Senior", "Junior", "Lead", "Principal", "Staff", "Chief", "Head", "Vice",
    "Deputy", "Associate", "Assistant", "Global", "Regional", "Group",
    "Product", "Project", "Program", "Programme", "Engineering", "Engineer",
    "Software", "Hardware", "Data", "Platform", "Systems", "Solutions",
    "Manager", "Director", "Officer", "Executive", "President", "Analyst",
    "Designer", "Developer", "Architect", "Consultant", "Specialist",
    "Coordinator", "Administrator", "Founder", "Partner", "Advisor",
    "Adviser", "Strategist", "Scientist", "Researcher", "Technician",
    "Representative", "Supervisor", "Recruiter", "Marketing", "Sales",
    "Operations", "Finance", "Legal", "Counsel", "Intern",
  ].map((word) => word.toLowerCase()),
);
const TITLE_PREFIX_RE = /^(?:Dr|Mr|Mrs|Ms|Miss|Prof|Rev)\.?$/i;
// Determiners / place-prefixes that a real personal GIVEN name effectively
// never begins with as a standalone first token, so a Title-Case phrase
// starting with one is a place/idiom, not a person ("Los Angeles", "The
// Hague", "New York"). Restricted to these four on purpose: El/La/Le/Les are
// deliberately EXCLUDED because they are legitimate given names ("El Greco",
// "La Toya", "Les Paul", "Le Carré") — using them here would leak a real
// name. El/La-prefixed non-names are handled by NON_NAME_PHRASES instead.
const LEADING_NON_NAME_WORDS = new Set(["los", "las", "the", "new"]);
// Curated multi-word Title-Case terms that are not personal names, matched
// case-insensitively against the whole entity text. The precise, collateral-
// free way to drop the El/La/San-prefixed non-names the leading-word rule
// won't touch. Seeded with the actual complaint class (weather phenomena)
// plus a few high-frequency places the NAME regex genuinely emits. Phrases
// with letters outside the regex accent class (á é í ó ú ñ) — e.g. "São
// Paulo" — never match NAME and are not candidates here. Kept intentionally
// minimal; the real long-tail fix is typed NER (Phase 2), not a growing list.
const NON_NAME_PHRASES = new Set([
  "costa rica",
  "el niño",
  "el salvador",
  "hong kong",
  "la niña",
  "puerto rico",
  "san diego",
  "san francisco",
  "santa monica",
  "sierra leone",
]);
// US SSN structural shape (3-2-4 digits, optional separators). Used to reject
// non-issuable area/group/serial ranges without affecting UK NI numbers,
// which carry letters and never match this all-digit shape.
const US_SSN_SHAPE_RE = /^(\d{3})[-\s]?(\d{2})[-\s]?(\d{4})$/;

/** Luhn (mod-10) checksum — every issuable card number passes; ~90% of random
 *  16-digit strings fail. */
function passesLuhn(text: string): boolean {
  const digits = text.replace(/\D/g, "");
  // Stryker disable next-line ConditionalExpression,BooleanLiteral: defensive
  // guard — an ACCT match always contains >= 16 digits, so digits.length is
  // never 0 here; forcing this branch cannot change any output.
  if (digits.length === 0) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    // Stryker disable next-line AssignmentOperator: equivalent — negating every
    // summand turns `sum` into `-sum`, and `-sum % 10 === 0` iff `sum % 10 === 0`,
    // so the Luhn pass/fail verdict is unchanged.
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** True when an all-digit ID match is an SSN with a structurally invalid
 *  area (000/666/900–999), group (00), or serial (0000). Returns false for
 *  non-SSN shapes (e.g. UK NI numbers) so they are never suppressed here. */
function isInvalidUsSsn(text: string): boolean {
  const m = US_SSN_SHAPE_RE.exec(text.trim());
  if (!m) return false;
  const [, area, group, serial] = m;
  return (
    area === "000" ||
    area === "666" ||
    Number(area) >= 900 ||
    group === "00" ||
    serial === "0000"
  );
}
const KNOWN_ORGANISATION_WORD_RE =
  /\b(?:Amazon|Apple|Google|Microsoft|OpenAI)\b/;
const ORGANISATION_DESCRIPTOR_WORD_RE =
  /\b(?:Services|Systems|Technologies|University|Corporation|Company|Limited|Ltd|LLC|Inc|Web)\b/g;

/**
 * Detect PII entities in text using regex patterns.
 * Returns all matches with their positions and confidence scores.
 */
export function detectPII(text: string): PIIEntity[] {
  const entities: PIIEntity[] = [];

  for (const { type, pattern, confidence } of PII_PATTERNS) {
    // Reset lastIndex for each scan (patterns use /g flag)
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      const entity = {
        type,
        text: match[0],
        startIndex: match.index,
        endIndex: match.index + match[0].length,
        confidence,
      };
      if (!shouldSuppressRegexEntity(entity, text)) {
        entities.push(entity);
      }
    }
  }

  entities.push(...detectContextualPII(text));

  // Sort by start position for consistent ordering
  entities.sort((a, b) => a.startIndex - b.startIndex);

  // Remove overlapping entities (keep highest confidence)
  const filtered: PIIEntity[] = [];
  for (const entity of entities) {
    const overlapping = filtered.find(
      (e) => entity.startIndex < e.endIndex && entity.endIndex > e.startIndex,
    );
    if (!overlapping) {
      filtered.push(entity);
    } else if (entity.confidence > overlapping.confidence) {
      const idx = filtered.indexOf(overlapping);
      filtered[idx] = entity;
    }
  }

  return filtered;
}

function detectContextualPII(text: string): PIIEntity[] {
  const entities: PIIEntity[] = [];

  addCaptureMatches(entities, text, NATURAL_DOB_RE, 1, "DOB", 0.8);
  addCaptureMatches(entities, text, NUMERIC_DOB_RE, 1, "DOB", 0.8);
  addCaptureMatches(entities, text, PROFILE_HANDLE_RE, 1, "HANDLE", 0.85);
  addCaptureMatches(entities, text, LINKEDIN_HANDLE_RE, 1, "HANDLE", 0.85);
  addCaptureMatches(entities, text, UNIX_USER_PATH_RE, 2, "PATH", 0.85);
  addCaptureMatches(entities, text, WINDOWS_USER_PATH_RE, 2, "PATH", 0.85);

  return entities;
}

function shouldSuppressRegexEntity(
  entity: PIIEntity,
  sourceText: string,
): boolean {
  // Stryker disable next-line LogicalOperator: equivalent — `startsWith("+44")`
  // already implies `type === "PHONE"` (no other entity text starts with "+44"),
  // and every non-+44 phone is \b-anchored so `previous` is never alphanumeric;
  // the body therefore returns false regardless of `&&` vs `||`.
  if (entity.type === "PHONE" && entity.text.startsWith("+44")) {
    const previous = sourceText[entity.startIndex - 1];
    return previous !== undefined && /[A-Za-z0-9]/.test(previous);
  }

  // Credit-card numbers must pass the Luhn checksum — a 16-digit group that
  // fails it is not a card (random reference/order numbers, IDs, etc.).
  if (entity.type === "ACCT") {
    return !passesLuhn(entity.text);
  }

  // SSNs with a non-issuable area/group/serial are not real numbers. (Leaves
  // UK NI numbers, which carry letters, untouched.)
  if (entity.type === "ID") {
    return isInvalidUsSsn(entity.text);
  }

  if (entity.type !== "NAME") return false;

  const tokens = entity.text.split(/[ \t]+/).filter(Boolean);
  const hasTitlePrefix = tokens.some((token) => TITLE_PREFIX_RE.test(token));

  // A curated non-name phrase ("El Niño", "San Francisco") is a place/idiom,
  // not a person — suppress precisely, with no collateral on real names.
  if (NON_NAME_PHRASES.has(entity.text.toLowerCase().replace(/[ \t]+/g, " "))) {
    return true;
  }

  // A Title-Case phrase beginning with a determiner/place-prefix a real given
  // name never starts with ("Los Angeles", "New York") is a place, not a name.
  if (
    !hasTitlePrefix &&
    tokens.length > 0 &&
    LEADING_NON_NAME_WORDS.has(tokens[0].toLowerCase())
  ) {
    return true;
  }

  // A phrase whose tokens are ALL generic role/title words is a job title,
  // not a person's name (no title prefix like "Dr" present). Suppress it.
  if (
    !hasTitlePrefix &&
    tokens.length > 0 &&
    tokens.every((token) => ROLE_TITLE_WORDS.has(token.toLowerCase()))
  ) {
    return true;
  }

  const descriptorCount = [
    ...entity.text.matchAll(ORGANISATION_DESCRIPTOR_WORD_RE),
  ].length;
  return (
    descriptorCount >= 2 ||
    (descriptorCount > 0 && KNOWN_ORGANISATION_WORD_RE.test(entity.text))
  );
}

function addCaptureMatches(
  entities: PIIEntity[],
  text: string,
  pattern: RegExp,
  groupIndex: number,
  type: string,
  confidence: number,
): void {
  const regex = new RegExp(pattern.source, pattern.flags);
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const captured = match[groupIndex];
    if (!captured) continue;
    const offset = match[0].lastIndexOf(captured);
    if (offset < 0) continue;
    const startIndex = match.index + offset;
    entities.push({
      type,
      text: captured,
      startIndex,
      endIndex: startIndex + captured.length,
      confidence,
    });
  }
}
