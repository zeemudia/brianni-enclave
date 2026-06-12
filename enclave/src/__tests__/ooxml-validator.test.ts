// OOXML container validation for `.docx`. Closes Codex round-2
// finding #5 — magic-byte alone (PK\x03\x04) accepts arbitrary ZIPs.
// Tests cover: valid .docx accepted; renamed JAR/ZIP rejected;
// missing required OOXML parts rejected; wrong content type rejected;
// malformed ZIP rejected.

import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';

import {
  extractDocxPlainText,
  validateDocxContainer,
} from '../tools/ooxml-validator';
import {
  validateFileForGateway,
  BINARY_EXTENSIONS,
} from '../tools/file-allowlist';

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    let c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}

interface ZipEntry {
  name: string;
  body: Uint8Array;
  compressed: boolean;
}

function makeZip(entries: ZipEntry[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const cdEntries: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = e.compressed ? new Uint8Array(deflateRawSync(e.body)) : e.body;
    const crc = crc32(e.body);
    const nameBuf = new TextEncoder().encode(e.name);
    const lhdr = new Uint8Array(30 + nameBuf.length);
    const ldv = new DataView(lhdr.buffer);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, 20, true);
    ldv.setUint16(6, 0, true);
    ldv.setUint16(8, e.compressed ? 8 : 0, true);
    ldv.setUint16(10, 0, true);
    ldv.setUint16(12, 0, true);
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, data.length, true);
    ldv.setUint32(22, e.body.length, true);
    ldv.setUint16(26, nameBuf.length, true);
    ldv.setUint16(28, 0, true);
    lhdr.set(nameBuf, 30);
    const local = new Uint8Array(lhdr.length + data.length);
    local.set(lhdr, 0);
    local.set(data, lhdr.length);
    locals.push(local);

    const cd = new Uint8Array(46 + nameBuf.length);
    const cdv = new DataView(cd.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0, true);
    cdv.setUint16(10, e.compressed ? 8 : 0, true);
    cdv.setUint16(12, 0, true);
    cdv.setUint16(14, 0, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, data.length, true);
    cdv.setUint32(24, e.body.length, true);
    cdv.setUint16(28, nameBuf.length, true);
    cdv.setUint16(30, 0, true);
    cdv.setUint16(32, 0, true);
    cdv.setUint16(34, 0, true);
    cdv.setUint16(36, 0, true);
    cdv.setUint32(38, 0, true);
    cdv.setUint32(42, offset, true);
    cd.set(nameBuf, 46);
    cdEntries.push(cd);
    offset += local.length;
  }
  const cdStart = offset;
  const cdLen = cdEntries.reduce((s, e) => s + e.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdLen, true);
  ev.setUint32(16, cdStart, true);
  const totalLen = locals.reduce((s, e) => s + e.length, 0) + cdLen + 22;
  const out = new Uint8Array(totalLen);
  let p = 0;
  for (const l of locals) {
    out.set(l, p);
    p += l.length;
  }
  for (const c of cdEntries) {
    out.set(c, p);
    p += c.length;
  }
  out.set(eocd, p);
  return out;
}

const WORDPROCESSINGML_CT =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

const VALID_CONTENT_TYPES_XML = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="${WORDPROCESSINGML_CT}"/></Types>`;
const VALID_RELS = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;
const VALID_DOCUMENT_XML = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>`;

function makeValidDocx(): Uint8Array {
  return makeZip([
    {
      name: '[Content_Types].xml',
      body: new TextEncoder().encode(VALID_CONTENT_TYPES_XML),
      compressed: true,
    },
    {
      name: '_rels/.rels',
      body: new TextEncoder().encode(VALID_RELS),
      compressed: true,
    },
    {
      name: 'word/document.xml',
      body: new TextEncoder().encode(VALID_DOCUMENT_XML),
      compressed: true,
    },
  ]);
}

describe('validateDocxContainer', () => {
  it('accepts a well-formed .docx with all required parts + correct content type', () => {
    const docx = makeValidDocx();
    expect(validateDocxContainer(docx)).toEqual({ ok: true });
  });

  it('rejects a buffer that does not start with the ZIP signature', () => {
    const not = new TextEncoder().encode('not a zip');
    expect(validateDocxContainer(not)).toEqual({
      ok: false,
      reason: 'NOT_A_ZIP',
    });
  });

  it('rejects a truncated buffer too short to hold an EOCD', () => {
    const tiny = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    expect(validateDocxContainer(tiny)).toEqual({
      ok: false,
      reason: 'NOT_A_ZIP',
    });
  });

  it('rejects a renamed plain JAR (ZIP with no OOXML parts)', () => {
    const jar = makeZip([
      {
        name: 'META-INF/MANIFEST.MF',
        body: new TextEncoder().encode('Manifest-Version: 1.0'),
        compressed: true,
      },
      {
        name: 'com/example/Foo.class',
        body: new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 0]),
        compressed: false,
      },
    ]);
    expect(validateDocxContainer(jar)).toEqual({
      ok: false,
      reason: 'MISSING_OOXML_PART',
    });
  });

  it('rejects a .docx-shaped ZIP missing word/document.xml', () => {
    const zip = makeZip([
      {
        name: '[Content_Types].xml',
        body: new TextEncoder().encode(VALID_CONTENT_TYPES_XML),
        compressed: true,
      },
      {
        name: '_rels/.rels',
        body: new TextEncoder().encode(VALID_RELS),
        compressed: true,
      },
      // word/document.xml deliberately omitted.
    ]);
    expect(validateDocxContainer(zip)).toEqual({
      ok: false,
      reason: 'MISSING_OOXML_PART',
    });
  });

  it('rejects a .docx-shaped ZIP missing _rels/.rels', () => {
    const zip = makeZip([
      {
        name: '[Content_Types].xml',
        body: new TextEncoder().encode(VALID_CONTENT_TYPES_XML),
        compressed: true,
      },
      {
        name: 'word/document.xml',
        body: new TextEncoder().encode(VALID_DOCUMENT_XML),
        compressed: true,
      },
    ]);
    expect(validateDocxContainer(zip)).toEqual({
      ok: false,
      reason: 'MISSING_OOXML_PART',
    });
  });

  it('rejects a .docx whose [Content_Types].xml does NOT declare wordprocessingml', () => {
    const wrong = makeZip([
      {
        name: '[Content_Types].xml',
        body: new TextEncoder().encode(
          `<?xml version="1.0"?><Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
        ),
        compressed: true,
      },
      {
        name: '_rels/.rels',
        body: new TextEncoder().encode(VALID_RELS),
        compressed: true,
      },
      {
        name: 'word/document.xml',
        body: new TextEncoder().encode(VALID_DOCUMENT_XML),
        compressed: true,
      },
    ]);
    expect(validateDocxContainer(wrong)).toEqual({
      ok: false,
      reason: 'WRONG_OOXML_TYPE',
    });
  });

  it('rejects a .docx when the wordprocessingml content type appears only in a comment', () => {
    const commentOnly = makeZip([
      {
        name: '[Content_Types].xml',
        body: new TextEncoder().encode(
          `<?xml version="1.0"?><Types><!-- ${WORDPROCESSINGML_CT} --><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
        ),
        compressed: true,
      },
      {
        name: '_rels/.rels',
        body: new TextEncoder().encode(VALID_RELS),
        compressed: true,
      },
      {
        name: 'word/document.xml',
        body: new TextEncoder().encode(VALID_DOCUMENT_XML),
        compressed: true,
      },
    ]);
    expect(validateDocxContainer(commentOnly)).toEqual({
      ok: false,
      reason: 'WRONG_OOXML_TYPE',
    });
  });
});

describe('extractDocxPlainText', () => {
  it('extracts readable text from the trusted word/document.xml part', () => {
    const documentXml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Jane Developer</w:t></w:r></w:p><w:p><w:r><w:t>Senior Frontend Engineer</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>London</w:t></w:r></w:p><w:p><w:r><w:t>Built privacy tools &amp; ATS-ready resumes.</w:t></w:r></w:p></w:body></w:document>`;
    const docx = makeZip([
      {
        name: '[Content_Types].xml',
        body: new TextEncoder().encode(VALID_CONTENT_TYPES_XML),
        compressed: true,
      },
      {
        name: '_rels/.rels',
        body: new TextEncoder().encode(VALID_RELS),
        compressed: true,
      },
      {
        name: 'word/document.xml',
        body: new TextEncoder().encode(documentXml),
        compressed: true,
      },
    ]);

    expect(extractDocxPlainText(docx)).toEqual({
      ok: true,
      text: [
        'Jane Developer',
        'Senior Frontend Engineer\tLondon',
        'Built privacy tools & ATS-ready resumes.',
      ].join('\n'),
      truncated: false,
    });
  });
});

describe('validateFileForGateway — .docx integration', () => {
  it('`.docx` is in the enclave BINARY_EXTENSIONS allowlist', () => {
    expect(BINARY_EXTENSIONS.has('.docx')).toBe(true);
  });

  it('accepts a valid .docx when fullBytes is provided', () => {
    const docx = makeValidDocx();
    expect(
      validateFileForGateway({
        filename: 'doc.docx',
        byteLength: docx.length,
        firstBytes: docx.slice(0, 16),
        fullBytes: docx,
      }),
    ).toEqual({ ok: true });
  });

  it('rejects a renamed JAR (passes magic-byte ZIP check but fails OOXML container)', () => {
    const jar = makeZip([
      {
        name: 'META-INF/MANIFEST.MF',
        body: new TextEncoder().encode('Manifest-Version: 1.0'),
        compressed: true,
      },
    ]);
    const verdict = validateFileForGateway({
      filename: 'sneaky.docx',
      byteLength: jar.length,
      firstBytes: jar.slice(0, 16),
      fullBytes: jar,
    });
    expect(verdict).toEqual({ ok: false, reason: 'FILE_CONTENT_MISMATCH' });
  });

  it('rejects when fullBytes is omitted (fail-closed)', () => {
    const docx = makeValidDocx();
    expect(
      validateFileForGateway({
        filename: 'doc.docx',
        byteLength: docx.length,
        firstBytes: docx.slice(0, 16),
        // fullBytes deliberately omitted
      }),
    ).toEqual({ ok: false, reason: 'FILE_CONTENT_MISMATCH' });
  });

  it('rejects a .docx that fails the PK magic check (first-bytes wrong)', () => {
    const fake = new Uint8Array([
      0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04,
    ]);
    expect(
      validateFileForGateway({
        filename: 'fake.docx',
        byteLength: fake.length,
        firstBytes: fake,
        fullBytes: fake,
      }),
    ).toEqual({ ok: false, reason: 'FILE_CONTENT_MISMATCH' });
  });
});
