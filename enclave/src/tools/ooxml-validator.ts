/**
 * OOXML (`.docx`, `.xlsx`, `.pptx`) container validator. Closes the
 * polyglot gap Codex round-2 finding #5 surfaced: magic-byte-only
 * (PK\x03\x04) accepts ANY ZIP / JAR, so downstream tooling (LLM,
 * user's OS) interprets the file differently from the gateway's
 * accept verdict.
 *
 * For `.docx` specifically we require:
 *   - Valid ZIP container (parseable central directory)
 *   - `[Content_Types].xml` present
 *   - `word/document.xml` present
 *   - `_rels/.rels` present
 *   - The `[Content_Types].xml` binds `/word/document.xml` to the
 *     wordprocessingml document content type (so a renamed `.docx`
 *     containing an Excel sheet is rejected at the gateway).
 *
 * No decompression is performed; the central directory walk is
 * filename-only. The content type check inflates `[Content_Types].xml`
 * because it can be Deflate-compressed and we need to read the
 * declared root content type.
 *
 * Scope: hand-rolled minimal parser, no dependency expansion. The
 * enclave PCR0 is sensitive to every new dep — adding jszip rotates
 * PCR0. We keep validation surface small + auditable.
 */

import { inflateRawSync } from 'node:zlib';

// ZIP format constants (PKZIP APPNOTE 6.3.x).
const EOCD_SIGNATURE = 0x06054b50; // End of central directory
const CD_FILE_SIGNATURE = 0x02014b50; // Central directory file header

/**
 * Required member-paths for a valid `.docx` (OOXML word-processing).
 * Stricter than the OPC base spec — a real Word document always ships
 * all four. A document missing `word/document.xml` is not a Word
 * document by any reasonable read.
 */
const DOCX_REQUIRED_MEMBERS = [
  '[Content_Types].xml',
  '_rels/.rels',
  'word/document.xml',
] as const;

const WORDPROCESSINGML_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

export type OoxmlValidationResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'NOT_A_ZIP'
        | 'ZIP_PARSE_ERROR'
        | 'MISSING_OOXML_PART'
        | 'WRONG_OOXML_TYPE';
    };

type OoxmlFailureReason = Extract<
  OoxmlValidationResult,
  { ok: false }
>['reason'];

export type DocxPlainTextResult =
  | { ok: true; text: string; truncated: boolean }
  | {
      ok: false;
      reason: OoxmlFailureReason | 'DOCUMENT_XML_UNREADABLE';
    };

type ZipMemberMeta = {
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

type ParseZipMembersResult =
  | { ok: true; members: Map<string, ZipMemberMeta> }
  | Extract<OoxmlValidationResult, { ok: false }>;

/**
 * Validate a `.docx` file buffer end-to-end. Returns `{ ok: true }`
 * iff the buffer is a parseable ZIP that contains every member of
 * {@link DOCX_REQUIRED_MEMBERS} AND `[Content_Types].xml` declares
 * the wordprocessingml.document.main content type.
 *
 * Time complexity: O(zip central directory size). The CD walks the
 * file once at the back; we never decompress except for the small
 * `[Content_Types].xml` member (typically <2 KB compressed).
 */
export function validateDocxContainer(
  bytes: Uint8Array,
): OoxmlValidationResult {
  const parsed = parseZipMembers(bytes);
  if (!parsed.ok) return parsed;
  const { members } = parsed;

  for (const required of DOCX_REQUIRED_MEMBERS) {
    if (!members.has(required)) {
      return { ok: false, reason: 'MISSING_OOXML_PART' };
    }
  }

  // Read [Content_Types].xml and confirm it declares wordprocessingml.
  const ctMeta = members.get('[Content_Types].xml')!;
  const ctBytes = extractMemberBody(bytes, ctMeta);
  if (ctBytes === null) {
    return { ok: false, reason: 'ZIP_PARSE_ERROR' };
  }
  const ctText = new TextDecoder('utf-8', { fatal: false }).decode(ctBytes);
  if (!contentTypesBindsWordDocument(ctText)) {
    return { ok: false, reason: 'WRONG_OOXML_TYPE' };
  }

  return { ok: true };
}

/**
 * Extract model-readable text from a validated `.docx` without trusting the
 * browser/mobile bridge to interpret document bytes. The caller should still
 * run `validateDocxContainer`; this function repeats that validation so direct
 * callers get the same fail-closed behavior.
 */
export function extractDocxPlainText(bytes: Uint8Array): DocxPlainTextResult {
  const parsed = parseZipMembers(bytes);
  if (!parsed.ok) return parsed;
  const containerResult = validateDocxContainer(bytes);
  if (!containerResult.ok) return containerResult;

  const documentBytes = inflateZipMember(bytes, 'word/document.xml');
  if (documentBytes === null) {
    return { ok: false, reason: 'DOCUMENT_XML_UNREADABLE' };
  }
  const xml = new TextDecoder('utf-8', { fatal: false }).decode(documentBytes);
  const text = extractTextFromWordDocumentXml(xml);
  const capped = capUtf8Text(text, MAX_EXTRACTED_TEXT_BYTES);
  return { ok: true, text: capped.text, truncated: capped.truncated };
}

export function inflateZipMember(
  bytes: Uint8Array,
  memberName: string,
): Uint8Array | null {
  const parsed = parseZipMembers(bytes);
  if (!parsed.ok) return null;
  const meta = parsed.members.get(memberName);
  if (!meta) return null;
  return extractMemberBody(bytes, meta);
}

export function zipHasMember(bytes: Uint8Array, memberName: string): boolean {
  const parsed = parseZipMembers(bytes);
  return parsed.ok && parsed.members.has(memberName);
}

function parseZipMembers(bytes: Uint8Array): ParseZipMembersResult {
  if (bytes.length < 22) return { ok: false, reason: 'NOT_A_ZIP' };
  if (
    bytes[0] !== 0x50 ||
    bytes[1] !== 0x4b ||
    bytes[2] !== 0x03 ||
    bytes[3] !== 0x04
  ) {
    return { ok: false, reason: 'NOT_A_ZIP' };
  }

  // Locate the End-Of-Central-Directory record. EOCD is at least 22
  // bytes and lives at the end of the file. Comment field can be up
  // to 65,535 bytes; we scan backward up to that bound.
  const eocdOffset = findEocd(bytes);
  if (eocdOffset < 0) return { ok: false, reason: 'ZIP_PARSE_ERROR' };

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cdSize = dv.getUint32(eocdOffset + 12, true);
  const cdOffset = dv.getUint32(eocdOffset + 16, true);
  if (cdOffset + cdSize > bytes.length || cdOffset < 0) {
    return { ok: false, reason: 'ZIP_PARSE_ERROR' };
  }

  const members = new Map<string, ZipMemberMeta>();
  let p = cdOffset;
  const cdEnd = cdOffset + cdSize;
  while (p < cdEnd) {
    if (p + 46 > bytes.length) {
      return { ok: false, reason: 'ZIP_PARSE_ERROR' };
    }
    if (dv.getUint32(p, true) !== CD_FILE_SIGNATURE) {
      return { ok: false, reason: 'ZIP_PARSE_ERROR' };
    }
    const compressionMethod = dv.getUint16(p + 10, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const uncompressedSize = dv.getUint32(p + 24, true);
    const fileNameLength = dv.getUint16(p + 28, true);
    const extraFieldLength = dv.getUint16(p + 30, true);
    const commentLength = dv.getUint16(p + 32, true);
    const localHeaderOffset = dv.getUint32(p + 42, true);
    const fileNameStart = p + 46;
    const fileNameEnd = fileNameStart + fileNameLength;
    if (fileNameEnd > bytes.length) {
      return { ok: false, reason: 'ZIP_PARSE_ERROR' };
    }
    const fileName = new TextDecoder('utf-8', { fatal: false }).decode(
      bytes.subarray(fileNameStart, fileNameEnd),
    );
    members.set(fileName, {
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    p = fileNameEnd + extraFieldLength + commentLength;
  }

  return { ok: true, members };
}

function contentTypesBindsWordDocument(xml: string): boolean {
  // Minimal XML token scan by design: the enclave avoids adding parser deps.
  // Comments are removed so content-type strings in comments cannot satisfy
  // the OOXML binding invariant.
  const withoutComments = xml.replace(/<!--[\s\S]*?-->/g, '');
  for (const match of withoutComments.matchAll(/<\s*Override\b([^>]*)>/gi)) {
    const attrs = parseXmlAttributes(match[1] ?? '');
    if (
      attrs.get('PartName') === '/word/document.xml' &&
      attrs.get('ContentType') === WORDPROCESSINGML_CONTENT_TYPE
    ) {
      return true;
    }
  }
  return false;
}

function parseXmlAttributes(src: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const attrPattern =
    /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of src.matchAll(attrPattern)) {
    attrs.set(match[1], match[2] ?? match[3] ?? '');
  }
  return attrs;
}

function findEocd(bytes: Uint8Array): number {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = Math.max(0, bytes.length - 22 - 65_535);
  for (let i = bytes.length - 22; i >= start; i -= 1) {
    if (dv.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

/**
 * Extract a single member's plaintext body. Handles compressionMethod 0
 * (stored) and 8 (deflate). Returns null on parse error or unsupported
 * compression. Caps decompressed output at `MAX_BODY_BYTES` so a
 * pathological compression ratio cannot OOM the gateway.
 */
const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MB — `[Content_Types].xml` is tiny in practice.
const MAX_EXTRACTED_TEXT_BYTES = 128 * 1024;

function extractMemberBody(
  bytes: Uint8Array,
  meta: ZipMemberMeta,
): Uint8Array | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const p = meta.localHeaderOffset;
  if (p + 30 > bytes.length) return null;
  // Local file header signature 0x04034b50.
  if (dv.getUint32(p, true) !== 0x04034b50) return null;
  const fileNameLength = dv.getUint16(p + 26, true);
  const extraFieldLength = dv.getUint16(p + 28, true);
  const dataStart = p + 30 + fileNameLength + extraFieldLength;
  const dataEnd = dataStart + meta.compressedSize;
  if (dataEnd > bytes.length) return null;
  if (meta.compressedSize > MAX_BODY_BYTES) return null;
  if (meta.uncompressedSize > MAX_BODY_BYTES) return null;

  const slice = bytes.subarray(dataStart, dataEnd);
  if (meta.compressionMethod === 0) {
    return slice;
  }
  if (meta.compressionMethod === 8) {
    try {
      const out = inflateRawSync(slice, { maxOutputLength: MAX_BODY_BYTES });
      return out;
    } catch {
      return null;
    }
  }
  return null;
}

function extractTextFromWordDocumentXml(xml: string): string {
  const paragraphPattern =
    /<([A-Za-z_][\w.-]*:)?p\b[\s\S]*?<\/([A-Za-z_][\w.-]*:)?p>/g;
  const paragraphs = [...xml.matchAll(paragraphPattern)].map((match) =>
    extractTextRuns(match[0]),
  );
  const parts = paragraphs.length > 0 ? paragraphs : [extractTextRuns(xml)];
  return parts
    .map((part) => part.replace(/[ \t]+\n/g, '\n').trim())
    .filter((part) => part.length > 0)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractTextRuns(xmlFragment: string): string {
  const tokenPattern =
    /<([A-Za-z_][\w.-]*:)?t\b[^>]*>([\s\S]*?)<\/([A-Za-z_][\w.-]*:)?t>|<([A-Za-z_][\w.-]*:)?tab\b[^>]*(?:\/>|>[\s\S]*?<\/([A-Za-z_][\w.-]*:)?tab>)|<([A-Za-z_][\w.-]*:)?(?:br|cr)\b[^>]*(?:\/>|>[\s\S]*?<\/([A-Za-z_][\w.-]*:)?(?:br|cr)>)/g;
  let out = '';
  for (const match of xmlFragment.matchAll(tokenPattern)) {
    if (match[2] !== undefined) {
      out += decodeXmlEntities(match[2]);
    } else if (match[0].includes('tab')) {
      out += '\t';
    } else {
      out += '\n';
    }
  }
  return out;
}

function decodeXmlEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g,
    (entity, body) => {
      switch (body) {
        case 'amp':
          return '&';
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'quot':
          return '"';
        case 'apos':
          return "'";
        default:
          if (body.startsWith('#x')) {
            return codePointToString(
              Number.parseInt(body.slice(2), 16),
              entity,
            );
          }
          if (body.startsWith('#')) {
            return codePointToString(
              Number.parseInt(body.slice(1), 10),
              entity,
            );
          }
          return entity;
      }
    },
  );
}

function codePointToString(value: number, fallback: string): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) {
    return fallback;
  }
  try {
    return String.fromCodePoint(value);
  } catch {
    return fallback;
  }
}

function capUtf8Text(
  value: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return { text: value, truncated: false };
  }
  let out = '';
  let bytes = 0;
  for (const char of value) {
    const nextBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + nextBytes > maxBytes) break;
    out += char;
    bytes += nextBytes;
  }
  return { text: out.trimEnd(), truncated: true };
}
