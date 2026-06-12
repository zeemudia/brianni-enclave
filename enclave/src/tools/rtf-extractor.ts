export interface ExtractedText {
  text: string;
  truncated: boolean;
}

const MAX_EXTRACTED_TEXT_BYTES = 128 * 1024;
const IGNORABLE_DESTINATIONS = new Set([
  'fonttbl',
  'colortbl',
  'stylesheet',
  'info',
  'pict',
  'object',
]);

export function extractRtfPlainText(bytes: Uint8Array): ExtractedText | null {
  const source = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (!source.startsWith('{\\rtf')) return null;
  const text = rtfToText(source);
  if (text.length === 0) return null;
  return capExtractedText(text, MAX_EXTRACTED_TEXT_BYTES);
}

export function capExtractedText(
  value: string,
  maxBytes = MAX_EXTRACTED_TEXT_BYTES,
): ExtractedText {
  const normalised = value
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (Buffer.byteLength(normalised, 'utf8') <= maxBytes) {
    return { text: normalised, truncated: false };
  }
  let out = '';
  let bytes = 0;
  for (const char of normalised) {
    const nextBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + nextBytes > maxBytes) break;
    out += char;
    bytes += nextBytes;
  }
  return { text: out.trimEnd(), truncated: true };
}

function rtfToText(source: string): string {
  const ignoredStack: boolean[] = [];
  let ignored = false;
  let out = '';

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') {
      ignoredStack.push(ignored);
      continue;
    }
    if (ch === '}') {
      ignored = ignoredStack.pop() ?? false;
      continue;
    }
    if (ch !== '\\') {
      if (!ignored) out += ch;
      continue;
    }

    const next = source[i + 1];
    if (next === '\\' || next === '{' || next === '}') {
      if (!ignored) out += next;
      i += 1;
      continue;
    }
    if (next === '*') {
      ignored = true;
      i += 1;
      continue;
    }
    if (next === "'") {
      const hex = source.slice(i + 2, i + 4);
      if (!ignored && /^[0-9a-fA-F]{2}$/.test(hex)) {
        out += String.fromCharCode(Number.parseInt(hex, 16));
      }
      i += 3;
      continue;
    }

    const controlStart = i + 1;
    let p = controlStart;
    while (p < source.length && /[A-Za-z]/.test(source[p])) p += 1;
    const word = source.slice(controlStart, p);
    let sign = 1;
    if (source[p] === '-') {
      sign = -1;
      p += 1;
    }
    const numberStart = p;
    while (p < source.length && /[0-9]/.test(source[p])) p += 1;
    const numberText = source.slice(numberStart, p);
    if (source[p] === ' ') p += 1;
    i = p - 1;

    if (word === '*') {
      ignored = true;
      continue;
    }
    if (IGNORABLE_DESTINATIONS.has(word)) {
      ignored = true;
      continue;
    }
    if (ignored) continue;
    switch (word) {
      case 'par':
      case 'line':
        out += '\n';
        break;
      case 'tab':
        out += '\t';
        break;
      case 'u': {
        const raw = sign * Number.parseInt(numberText || '0', 10);
        if (Number.isInteger(raw)) {
          // RTF \uN with a negative N encodes code points above 0x7FFF as a
          // signed 16-bit value; normalise back to the unsigned code point.
          const codePoint = raw < 0 ? 0x10000 + raw : raw;
          // Only emit a character for a valid Unicode scalar value. Out-of-range
          // (> 0x10FFFF, < 0) or lone-surrogate (0xD800-0xDFFF) values would make
          // String.fromCodePoint throw / yield an invalid string, which must not
          // abort the whole extraction. Substitute U+FFFD instead.
          if (
            codePoint >= 0 &&
            codePoint <= 0x10ffff &&
            !(codePoint >= 0xd800 && codePoint <= 0xdfff)
          ) {
            out += String.fromCodePoint(codePoint);
          } else {
            out += '�';
          }
        }
        break;
      }
      default:
        break;
    }
  }

  return out;
}
