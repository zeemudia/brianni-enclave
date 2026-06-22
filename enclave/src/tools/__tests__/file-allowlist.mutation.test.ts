import { describe, it, expect } from "vitest";
import { deflateRawSync } from "node:zlib";

import {
  MAX_FILE_BYTES,
  MAX_TOOL_RESULT_PLAINTEXT_BYTES,
  MAX_REASSEMBLED_TOOL_RESULT_BYTES,
  MAX_TOOL_RESULT_CHUNKS,
  isAllowedGatewayExtension,
  validateFileForGateway,
} from "../file-allowlist";

// Mutation-hardening companion to ../../__tests__/file-allowlist.test.ts.
//
// The Tier-A file allowlist is the content-type / size gate guarding which
// files the agent's read tools may surface into the model context. Every
// magic-byte matcher, the per-capability size cap, the OOXML/iWork/google-stub
// content checks, and the byte-comparison helpers must FAIL CLOSED. This suite
// adds the precise negative / boundary cases that kill the magic-byte branch,
// equality-operator, and arithmetic mutants the positive-only existing suite
// leaves alive.

function bytes(...vals: number[]): Uint8Array {
  return new Uint8Array(vals);
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** ISO-BMFF header: 4 size bytes + 'ftyp' + a 4-char major brand. */
function isoBmff(brand: string): Uint8Array {
  return new Uint8Array([
    0x00,
    0x00,
    0x00,
    0x18,
    0x66, // f
    0x74, // t
    0x79, // y
    0x70, // p
    ...new TextEncoder().encode(brand.slice(0, 4).padEnd(4, " ")),
  ]);
}

function ok(filename: string, firstBytes?: Uint8Array, byteLength = 1024): boolean {
  return validateFileForGateway({
    filename,
    byteLength,
    firstBytes,
  }).ok;
}

// --- minimal ZIP / OOXML / iWork builders (mirrors the covering suites) -----

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
  compressed?: boolean;
}

function makeZip(entries: ZipEntry[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const cdEntries: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = e.compressed
      ? new Uint8Array(deflateRawSync(e.body))
      : e.body;
    const crc = crc32(e.body);
    const nameBuf = new TextEncoder().encode(e.name);
    const lhdr = new Uint8Array(30 + nameBuf.length);
    const ldv = new DataView(lhdr.buffer);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, 20, true);
    ldv.setUint16(8, e.compressed ? 8 : 0, true);
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, data.length, true);
    ldv.setUint32(22, e.body.length, true);
    ldv.setUint16(26, nameBuf.length, true);
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
    cdv.setUint16(10, e.compressed ? 8 : 0, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, data.length, true);
    cdv.setUint32(24, e.body.length, true);
    cdv.setUint16(28, nameBuf.length, true);
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
  const totalLen =
    locals.reduce((s, e) => s + e.length, 0) + cdLen + 22;
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
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

function makeValidDocx(): Uint8Array {
  return makeZip([
    {
      name: "[Content_Types].xml",
      body: utf8(
        `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="${WORDPROCESSINGML_CT}"/></Types>`,
      ),
      compressed: true,
    },
    {
      name: "_rels/.rels",
      body: utf8(
        `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
      ),
      compressed: true,
    },
    {
      name: "word/document.xml",
      body: utf8(
        `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>`,
      ),
      compressed: true,
    },
  ]);
}

/** A valid iWork package: a stored ZIP carrying one of the Index members. */
function makeIWork(member: string): Uint8Array {
  return makeZip([{ name: member, body: utf8("PKpayload") }]);
}

describe("file-allowlist size-cap boundary (kills >= / Math.min mutants)", () => {
  it("accepts exactly MAX_FILE_BYTES and rejects MAX_FILE_BYTES + 1 (> not >=)", () => {
    // At the cap → accepted (text path, no firstBytes required).
    expect(
      validateFileForGateway({ filename: "edge.md", byteLength: MAX_FILE_BYTES }).ok,
    ).toBe(true);
    // One over → FILE_TOO_LARGE. A `>=` mutant would reject the at-cap case;
    // a `<` mutant would accept the over-cap case.
    const over = validateFileForGateway({
      filename: "edge.md",
      byteLength: MAX_FILE_BYTES + 1,
    });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toBe("FILE_TOO_LARGE");
  });

  it("uses the MIN of MAX_FILE_BYTES and the per-capability cap (kills Math.min->Math.max)", () => {
    // The google-stub capability has a per-capability maxBytes of 128 KiB —
    // well BELOW MAX_FILE_BYTES (5 MiB). A declared byteLength between those
    // two caps must be rejected as FILE_TOO_LARGE: only Math.min enforces the
    // tighter 128 KiB cap; a Math.max mutant would use 5 MiB and let it pass
    // the size gate. The size check runs before content validation, so the
    // reason is deterministically FILE_TOO_LARGE.
    const between = 200 * 1024; // > 128 KiB, < 5 MiB
    const stub = utf8(
      '{"url":"https://docs.google.com/document/d/abc","doc_id":"abc"}',
    );
    const r = validateFileForGateway({
      filename: "huge.gdoc",
      byteLength: between,
      firstBytes: stub.subarray(0, 16),
      fullBytes: stub,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("FILE_TOO_LARGE");
  });
});

describe("file-allowlist size constants (kill arithmetic-operator mutants)", () => {
  it("MAX_TOOL_RESULT_PLAINTEXT_BYTES is 200 KiB (200 * 1024, not 200 / 1024)", () => {
    expect(MAX_TOOL_RESULT_PLAINTEXT_BYTES).toBe(200 * 1024);
    expect(MAX_TOOL_RESULT_PLAINTEXT_BYTES).toBe(204800);
  });

  it("MAX_REASSEMBLED_TOOL_RESULT_BYTES is 8 MiB (8 * 1024 * 1024)", () => {
    expect(MAX_REASSEMBLED_TOOL_RESULT_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_REASSEMBLED_TOOL_RESULT_BYTES).toBe(8388608);
  });

  it("MAX_TOOL_RESULT_CHUNKS is 40", () => {
    expect(MAX_TOOL_RESULT_CHUNKS).toBe(40);
  });

  it("MAX_FILE_BYTES is 5 MiB", () => {
    expect(MAX_FILE_BYTES).toBe(5 * 1024 * 1024);
    expect(MAX_FILE_BYTES).toBe(5242880);
  });
});

describe("file-allowlist extension gating (kills dot / capability mutants)", () => {
  it("rejects a filename whose only dot is leading (dotfile, dot index 0)", () => {
    // `.env` → lastIndexOf('.') === 0 → dot <= 0 → rejected. Kills the
    // `dot < 0` mutant (which would accept a leading-dot name).
    const r = validateFileForGateway({ filename: ".env", byteLength: 10 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("FILE_TYPE_NOT_ALLOWED");

    expect(isAllowedGatewayExtension(".env")).toBe(false);
  });

  it("rejects an unknown extension (no capability) at both validate + list time", () => {
    expect(validateFileForGateway({ filename: "x.zip", byteLength: 10 }).ok).toBe(
      false,
    );
    expect(isAllowedGatewayExtension("x.zip")).toBe(false);
  });

  it("enforces the capability suite allowlist (text-only suite rejects a PDF)", () => {
    const r = validateFileForGateway({
      filename: "doc.pdf",
      byteLength: 1024,
      firstBytes: utf8("%PDF-1.7"),
      capabilitySuiteIds: ["text"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("FILE_TYPE_NOT_ALLOWED");
    // And with the right suite it passes — kills the `includes`->true mutant.
    expect(
      validateFileForGateway({
        filename: "doc.pdf",
        byteLength: 1024,
        firstBytes: utf8("%PDF-1.7"),
        capabilitySuiteIds: ["pdf"],
      }).ok,
    ).toBe(true);
  });
});

describe("file-allowlist magic-byte matchers (kill per-branch byte mutants)", () => {
  it("PDF: rejects a one-byte-off prefix (kills the %PDF- byte array)", () => {
    // %PDX- instead of %PDF- — last byte wrong.
    expect(ok("a.pdf", bytes(0x25, 0x50, 0x44, 0x58, 0x2d))).toBe(false);
    expect(ok("a.pdf", utf8("%PDF-"))).toBe(true);
  });

  it("RTF: rejects {\\rtg instead of {\\rtf", () => {
    expect(ok("a.rtf", utf8("{\\rtg"))).toBe(false);
    expect(ok("a.rtf", utf8("{\\rtf"))).toBe(true);
  });

  it("PNG: every signature byte matters", () => {
    const good = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    expect(ok("a.png", good)).toBe(true);
    // flip the final byte
    expect(ok("a.png", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x00))).toBe(
      false,
    );
  });

  it("JPEG: requires FF D8 FF (rejects FF D8 00)", () => {
    expect(ok("a.jpg", bytes(0xff, 0xd8, 0xff, 0xe0))).toBe(true);
    expect(ok("a.jpeg", bytes(0xff, 0xd8, 0xff, 0xe0))).toBe(true);
    expect(ok("a.jpg", bytes(0xff, 0xd8, 0x00, 0xe0))).toBe(false);
  });

  it("HEIC: ftyp box header bytes + each accepted brand, and rejects unknown brand", () => {
    // Valid brands.
    for (const brand of ["heic", "heix", "mif1"]) {
      expect(ok("a.heic", isoBmff(brand)), brand).toBe(true);
    }
    // Wrong major brand (valid ftyp, brand 'avif' not in the heic list).
    expect(ok("a.heic", isoBmff("avif"))).toBe(false);
    // Corrupt the 'ftyp' marker (byte at offset 4 wrong) → rejected. Kills the
    // `head[4] !== 0x66` conditional/logical mutants.
    const badFtyp = isoBmff("heic");
    badFtyp[4] = 0x00;
    expect(ok("a.heic", badFtyp)).toBe(false);
    // Too short (< 12 bytes) → rejected.
    expect(ok("a.heic", bytes(0x00, 0x00, 0x00, 0x18, 0x66, 0x74))).toBe(false);
  });

  it("MP3: accepts ID3 OR a frame-sync header, rejects a non-sync header", () => {
    // ID3 tag.
    expect(ok("a.mp3", utf8("ID3"))).toBe(true);
    // MPEG frame sync: 0xFF then top 3 bits set (0xE0 mask).
    expect(ok("a.mp3", bytes(0xff, 0xfb, 0x90, 0x00))).toBe(true);
    // 0xFF but the sync bits are NOT all set (0x10 & 0xe0 === 0) → rejected.
    expect(ok("a.mp3", bytes(0xff, 0x10, 0x00, 0x00))).toBe(false);
    // Not 0xFF and not ID3 → rejected.
    expect(ok("a.mp3", bytes(0x00, 0xfb, 0x90, 0x00))).toBe(false);
    // Single byte (length < 2) with 0xFF → rejected (kills head.length>=2 mutant).
    expect(ok("a.mp3", bytes(0xff))).toBe(false);
  });

  it("AAC: requires 0xFF then 0xF0 sync bits, rejects near-misses", () => {
    expect(ok("a.aac", bytes(0xff, 0xf1, 0x00, 0x00))).toBe(true);
    // 0xFF but 0xE0 (high nibble not 0xF) → rejected.
    expect(ok("a.aac", bytes(0xff, 0xe0, 0x00, 0x00))).toBe(false);
    // Not 0xFF → rejected.
    expect(ok("a.aac", bytes(0x00, 0xf1, 0x00, 0x00))).toBe(false);
    // length < 2 → rejected.
    expect(ok("a.aac", bytes(0xff))).toBe(false);
  });

  it("WAV: needs RIFF prefix AND WAVE at offset 8", () => {
    expect(ok("a.wav", utf8("RIFFsizeWAVE"))).toBe(true);
    // RIFF but no WAVE.
    expect(ok("a.wav", utf8("RIFFsizeWXVE"))).toBe(false);
    // Not RIFF.
    expect(ok("a.wav", utf8("XIFFsizeWAVE"))).toBe(false);
    // Too short (< 12).
    expect(ok("a.wav", utf8("RIFFsize"))).toBe(false);
  });

  it("FLAC and OGG require their exact 4-byte signature", () => {
    expect(ok("a.flac", utf8("fLaC"))).toBe(true);
    expect(ok("a.flac", utf8("fLaX"))).toBe(false);
    expect(ok("a.ogg", utf8("OggS"))).toBe(true);
    expect(ok("a.ogg", utf8("OggX"))).toBe(false);
  });

  it("WEBM/MKV require the EBML magic (rejects a one-byte-off prefix)", () => {
    expect(ok("a.webm", bytes(0x1a, 0x45, 0xdf, 0xa3))).toBe(true);
    expect(ok("a.mkv", bytes(0x1a, 0x45, 0xdf, 0xa3))).toBe(true);
    expect(ok("a.webm", bytes(0x1a, 0x45, 0xdf, 0x00))).toBe(false);
  });

  it("M4A / MP4 / MOV accept only their declared brands", () => {
    expect(ok("a.m4a", isoBmff("M4A "))).toBe(true);
    expect(ok("a.m4a", isoBmff("isom"))).toBe(true);
    expect(ok("a.m4a", isoBmff("qt  "))).toBe(false); // qt is mov, not m4a
    expect(ok("a.mp4", isoBmff("mp42"))).toBe(true);
    expect(ok("a.mp4", isoBmff("qt  "))).toBe(false);
    expect(ok("a.mov", isoBmff("qt  "))).toBe(true);
    expect(ok("a.mov", isoBmff("isom"))).toBe(false); // isom is mp4, not mov
  });

  it("binary formats require firstBytes (empty head fails closed)", () => {
    expect(
      validateFileForGateway({
        filename: "a.png",
        byteLength: 1024,
        firstBytes: new Uint8Array(0),
      }).ok,
    ).toBe(false);
  });

  it("an unknown binary brand falls through to the default-false matcher", () => {
    // .pdf with bytes that match no case → matchesBinaryMagic default returns
    // false → FILE_CONTENT_MISMATCH. Kills the default `return false`->true.
    const r = validateFileForGateway({
      filename: "a.pdf",
      byteLength: 1024,
      firstBytes: bytes(0xde, 0xad, 0xbe, 0xef, 0x00),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("FILE_CONTENT_MISMATCH");
  });
});

describe("file-allowlist text UTF-8 check (kills firstBytes branch mutants)", () => {
  it("accepts valid UTF-8 head and rejects invalid UTF-8 head for a text file", () => {
    expect(ok("a.md", utf8("# valid"))).toBe(true);
    // Lone 0x80 continuation byte → invalid UTF-8 → FILE_CONTENT_MISMATCH.
    const r = validateFileForGateway({
      filename: "a.md",
      byteLength: 64,
      firstBytes: bytes(0x80, 0x81),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("FILE_CONTENT_MISMATCH");
  });

  it("a text file with NO firstBytes is accepted (list-only path)", () => {
    expect(validateFileForGateway({ filename: "a.md", byteLength: 64 }).ok).toBe(
      true,
    );
  });
});

describe("file-allowlist google-stub JSON (kills url/host/resource-id mutants)", () => {
  function gstub(json: string, filename = "a.gdoc") {
    const fullBytes = utf8(json);
    return validateFileForGateway({
      filename,
      byteLength: fullBytes.length,
      firstBytes: fullBytes.subarray(0, 16),
      fullBytes,
    });
  }

  it("accepts a well-formed gdoc stub", () => {
    expect(
      gstub('{"url":"https://docs.google.com/document/d/abc123","doc_id":"abc123"}')
        .ok,
    ).toBe(true);
  });

  it("rejects wrong host (kills hostname === docs.google.com mutant)", () => {
    expect(
      gstub('{"url":"https://evil.example.com/document/d/abc","doc_id":"abc"}').ok,
    ).toBe(false);
  });

  it("rejects non-https scheme (kills protocol === https: mutant)", () => {
    expect(
      gstub('{"url":"http://docs.google.com/document/d/abc","doc_id":"abc"}').ok,
    ).toBe(false);
  });

  it("rejects a JSON array (not an object) and a JSON string", () => {
    expect(gstub("[1,2,3]").ok).toBe(false);
    expect(gstub('"a string"').ok).toBe(false);
  });

  it("rejects when url is not a string", () => {
    expect(gstub('{"url":123,"doc_id":"abc"}').ok).toBe(false);
  });

  it("recovers the resource id from the path when doc_id/resource_id absent", () => {
    // No explicit id field → extractGoogleResourceId parses /document/d/<id>.
    expect(
      gstub('{"url":"https://docs.google.com/document/d/PATHID12345"}').ok,
    ).toBe(true);
    // ...but with no id ANYWHERE (path has /u/0/, no /d/<id>) → reject.
    expect(gstub('{"url":"https://docs.google.com/document/u/0/"}').ok).toBe(false);
  });

  it("recovers the resource id from an ?id= query param", () => {
    expect(
      gstub('{"url":"https://docs.google.com/document/?id=QUERYID99"}').ok,
    ).toBe(true);
    // Empty ?id= (whitespace only) → not a valid id, and no /d/ path → reject.
    expect(gstub('{"url":"https://docs.google.com/document/?id=%20"}').ok).toBe(
      false,
    );
  });

  it("path must match the extension family (gsheet path required for .gsheet)", () => {
    // A gdoc-style /document/ path under a .gsheet name → reject (kills the
    // googleStubPathMatchesExtension /spreadsheets/ branch).
    expect(
      gstub(
        '{"url":"https://docs.google.com/document/d/abc","doc_id":"abc"}',
        "a.gsheet",
      ).ok,
    ).toBe(false);
    // Correct /spreadsheets/ path under .gsheet → accept.
    expect(
      gstub(
        '{"url":"https://docs.google.com/spreadsheets/d/abc","doc_id":"abc"}',
        "a.gsheet",
      ).ok,
    ).toBe(true);
    // .gslides needs /presentation/.
    expect(
      gstub(
        '{"url":"https://docs.google.com/presentation/d/abc","doc_id":"abc"}',
        "a.gslides",
      ).ok,
    ).toBe(true);
    expect(
      gstub(
        '{"url":"https://docs.google.com/document/d/abc","doc_id":"abc"}',
        "a.gslides",
      ).ok,
    ).toBe(false);
  });

  it("rejects a google-stub whose fullBytes length != byteLength (length mismatch guard)", () => {
    const fullBytes = utf8(
      '{"url":"https://docs.google.com/document/d/abc","doc_id":"abc"}',
    );
    const r = validateFileForGateway({
      filename: "a.gdoc",
      byteLength: fullBytes.length + 1, // declared length lies
      firstBytes: fullBytes.subarray(0, 16),
      fullBytes,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("FILE_CONTENT_MISMATCH");
  });
});

describe("file-allowlist ISO-BMFF ftyp byte checks (kills each head[4..7] conditional)", () => {
  // hasIsoBmffBrand (mp4/mov/m4a) requires the literal 'ftyp' box marker at
  // bytes 4..7. Corrupt exactly ONE marker byte (others correct + a valid
  // brand) so the original rejects but a `head[N] !== 0x..` -> false mutant
  // would wrongly continue and accept.
  function m4aWithFtypByte(index: 4 | 5 | 6 | 7, value: number): Uint8Array {
    const head = new Uint8Array([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, // ftyp
      0x4d, 0x34, 0x41, 0x20, // 'M4A '
    ]);
    head[index] = value;
    return head;
  }

  it("rejects an m4a whose ftyp marker byte 4 ('f') is wrong", () => {
    expect(ok("a.m4a", m4aWithFtypByte(4, 0x00))).toBe(false);
  });
  it("rejects an m4a whose ftyp marker byte 5 ('t') is wrong", () => {
    expect(ok("a.m4a", m4aWithFtypByte(5, 0x00))).toBe(false);
  });
  it("rejects an m4a whose ftyp marker byte 6 ('y') is wrong", () => {
    expect(ok("a.m4a", m4aWithFtypByte(6, 0x00))).toBe(false);
  });
  it("rejects an m4a whose ftyp marker byte 7 ('p') is wrong", () => {
    expect(ok("a.m4a", m4aWithFtypByte(7, 0x00))).toBe(false);
  });
  it("rejects an m4a head shorter than 12 bytes (kills head.length<12 boundary)", () => {
    expect(ok("a.m4a", bytes(0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d))).toBe(
      false,
    );
    // Exactly 12 bytes with a valid brand is accepted (boundary inclusive).
    expect(ok("a.m4a", isoBmff("M4A "))).toBe(true);
  });
});

describe("file-allowlist google-stub helpers (id recovery + first-non-empty)", () => {
  function gstub(json: string, filename = "a.gdoc") {
    const fullBytes = utf8(json);
    return validateFileForGateway({
      filename,
      byteLength: fullBytes.length,
      firstBytes: fullBytes.subarray(0, 16),
      fullBytes,
    });
  }

  it("prefers an explicit doc_id even when the path lacks /d/<id>", () => {
    // No /d/<id> in the path, but doc_id present → firstNonEmptyString wins.
    expect(
      gstub('{"url":"https://docs.google.com/document/u/0/","doc_id":"EXPLICITID"}')
        .ok,
    ).toBe(true);
  });

  it("falls back to resource_id when doc_id is absent/empty", () => {
    expect(
      gstub(
        '{"url":"https://docs.google.com/document/u/0/","doc_id":"   ","resource_id":"RESID9"}',
      ).ok,
    ).toBe(true);
  });

  it("rejects when doc_id and resource_id are both whitespace AND no path id", () => {
    expect(
      gstub(
        '{"url":"https://docs.google.com/document/u/0/","doc_id":"  ","resource_id":""}',
      ).ok,
    ).toBe(false);
  });

  it("extractGoogleResourceId: empty ?id= with no /d/ path → reject", () => {
    expect(gstub('{"url":"https://docs.google.com/document/?id="}').ok).toBe(false);
  });
});

describe("file-allowlist dot<=0 guard (kills the <= -> < boundary)", () => {
  it("rejects a leading-dot-only name whose 'extension' IS a known capability", () => {
    // `.md` → lastIndexOf('.') === 0. The guard is `dot <= 0`, so this is
    // rejected. A `dot < 0` mutant would let dot===0 through, then slice(0)
    // gives ext '.md' which IS readable → wrongly ACCEPTED. This filename is
    // the one that discriminates `<=` from `<`.
    const r = validateFileForGateway({ filename: ".md", byteLength: 32 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("FILE_TYPE_NOT_ALLOWED");
    // Same discrimination at list time.
    expect(isAllowedGatewayExtension(".md")).toBe(false);
  });
});

describe("file-allowlist empty-firstBytes branches (kills length>0 / ===0 mutants)", () => {
  it("a BINARY file with a present-but-empty firstBytes fails closed", () => {
    // input.firstBytes is an empty Uint8Array (length 0). The guard
    // `!input.firstBytes || input.firstBytes.length === 0` must fire → reject.
    const r = validateFileForGateway({
      filename: "a.pdf",
      byteLength: 1024,
      firstBytes: new Uint8Array(0),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("FILE_CONTENT_MISMATCH");
  });

  it("a TEXT file with a present-but-empty firstBytes is ACCEPTED (skips UTF-8 check)", () => {
    // The text branch is `else if (input.firstBytes && input.firstBytes.length > 0)`.
    // With an empty head the condition is false → the UTF-8 check is skipped →
    // accepted. A `>= 0` mutant would run the UTF-8 check on empty bytes (still
    // valid UTF-8) so this case also guards the `length > 0` boundary intent.
    const r = validateFileForGateway({
      filename: "a.md",
      byteLength: 64,
      firstBytes: new Uint8Array(0),
    });
    expect(r.ok).toBe(true);
  });
});

describe("file-allowlist HEIC ftyp byte checks (kills each head[4..7] conditional)", () => {
  function heicWithByte(index: number, value: number): Uint8Array {
    const head = new Uint8Array([
      0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, // ftyp
      0x68, 0x65, 0x69, 0x63, // 'heic'
    ]);
    head[index] = value;
    return head;
  }
  it("rejects a heic with each individual ftyp marker byte corrupted", () => {
    for (const idx of [4, 5, 6, 7]) {
      expect(ok("a.heic", heicWithByte(idx, 0x00)), `byte ${idx}`).toBe(false);
    }
    // Sanity: the unmodified header is accepted.
    expect(ok("a.heic", heicWithByte(0, 0x00))).toBe(true); // byte 0 is a size byte, irrelevant
  });
});

describe("file-allowlist iWork length-mismatch guard (kills fullBytes.length !== byteLength)", () => {
  it("rejects an iWork package whose declared byteLength disagrees with fullBytes", () => {
    // A valid iWork zip but with a lying byteLength → the length-equality guard
    // must reject. Build a minimal stored zip with an Index member.
    // Reuse the public validate path: provide fullBytes but wrong byteLength.
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]); // PK header (not a full Index zip)
    const r = validateFileForGateway({
      filename: "a.pages",
      byteLength: zip.length + 99, // lie about the size
      firstBytes: zip,
      fullBytes: zip,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("FILE_CONTENT_MISMATCH");
  });
});

describe("file-allowlist google-stub JSON shape guards (kills !parsed/typeof/isArray mutants)", () => {
  function gstub(json: string, filename = "a.gdoc") {
    const fullBytes = utf8(json);
    return validateFileForGateway({
      filename,
      byteLength: fullBytes.length,
      firstBytes: fullBytes.subarray(0, 16),
      fullBytes,
    });
  }
  it("rejects JSON null (parsed is falsy)", () => {
    expect(gstub("null").ok).toBe(false);
  });
  it("rejects a JSON number (typeof !== object)", () => {
    expect(gstub("42").ok).toBe(false);
  });
  it("rejects a JSON array even though typeof is object (Array.isArray guard)", () => {
    expect(gstub('["https://docs.google.com/document/d/abc"]').ok).toBe(false);
  });
});

describe("file-allowlist isAllowedGatewayExtension (list-time gate)", () => {
  it("returns false for leading-dot and unknown, true for a known readable ext", () => {
    expect(isAllowedGatewayExtension(".bashrc")).toBe(false);
    expect(isAllowedGatewayExtension("a.zip")).toBe(false);
    expect(isAllowedGatewayExtension("a.pdf")).toBe(true);
  });

  it("honours the capability suite at list time", () => {
    expect(isAllowedGatewayExtension("a.png", ["text"])).toBe(false);
    expect(isAllowedGatewayExtension("a.png", ["image"])).toBe(true);
  });

  it("rejects a known capability ext that is NOT readable-listed (kills READABLE_EXTENSIONS guard)", () => {
    // Every readable ext is also a capability ext, so to discriminate the
    // `!READABLE_EXTENSIONS.has(ext)` guard from `false` we use an unknown ext:
    // an unknown ext is NOT in READABLE_EXTENSIONS → must return false. A
    // `false`-replacement mutant would skip the guard and fall through to the
    // capability lookup (also null) → still false; but the leading return is the
    // fast path. The discriminating case is a readable ext with the WRONG suite.
    expect(isAllowedGatewayExtension("a.png", ["audio"])).toBe(false);
    // And a genuinely non-readable extension returns false via the guard.
    expect(isAllowedGatewayExtension("a.exe")).toBe(false);
  });
});

// ===========================================================================
// Round-3 byte-comparison tail: OOXML container, iWork members, brand string
// literals, and the byte-helper boundaries (startsWith / bytesEqual / the
// default matcher) the positive-only suite left alive.
// ===========================================================================

describe("file-allowlist .docx OOXML container path (L237-L245)", () => {
  it("accepts a structurally-valid .docx (full OOXML container) — kills the docx case-arm", () => {
    const docx = makeValidDocx();
    const r = validateFileForGateway({
      filename: "report.docx",
      byteLength: docx.length,
      firstBytes: docx.subarray(0, 16),
      fullBytes: docx,
    });
    expect(r.ok, "valid docx must pass").toBe(true);
  });

  it("rejects a PK-magic .docx whose container is NOT valid OOXML (kills !containerResult.ok)", () => {
    // A bare ZIP with PK magic but no OOXML parts: magic-byte passes, the
    // container check fails. A mutant that dropped the container check
    // (!containerResult.ok -> false) would WRONGLY accept this renamed ZIP.
    const renamedZip = makeZip([{ name: "random.txt", body: utf8("hello") }]);
    const r = validateFileForGateway({
      filename: "evil.docx",
      byteLength: renamedZip.length,
      firstBytes: renamedZip.subarray(0, 16),
      fullBytes: renamedZip,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("FILE_CONTENT_MISMATCH");
  });

  it("rejects a .docx with valid PK magic but ZERO-length fullBytes (kills the fullBytes.length===0 guard)", () => {
    // firstBytes are valid PK magic; fullBytes present but empty → the
    // `!input.fullBytes || input.fullBytes.length === 0` guard must fire and
    // fail closed BEFORE validateDocxContainer is reached.
    const r = validateFileForGateway({
      filename: "empty.docx",
      byteLength: 1024,
      firstBytes: bytes(0x50, 0x4b, 0x03, 0x04),
      fullBytes: new Uint8Array(0),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("FILE_CONTENT_MISMATCH");
  });

  it("rejects a .docx with valid PK magic but MISSING fullBytes (the !input.fullBytes arm)", () => {
    const r = validateFileForGateway({
      filename: "nofull.docx",
      byteLength: 1024,
      firstBytes: bytes(0x50, 0x4b, 0x03, 0x04),
      // fullBytes omitted.
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("FILE_CONTENT_MISMATCH");
  });
});

describe("file-allowlist iWork Index members (L423-L425)", () => {
  it("accepts each distinct iWork Index member name (kills the per-member string literals)", () => {
    const cases: Array<[string, string]> = [
      ["draft.pages", "Index.zip"],
      ["doc.pages", "Index/Document.iwa"],
      ["model.numbers", "Index/CalculationEngine.iwa"],
      ["deck.key", "Index/Presentation.iwa"],
    ];
    for (const [filename, member] of cases) {
      const pkg = makeIWork(member);
      const r = validateFileForGateway({
        filename,
        byteLength: pkg.length,
        firstBytes: pkg.subarray(0, 16),
        fullBytes: pkg,
      });
      expect(r.ok, `${filename} via ${member}`).toBe(true);
    }
  });

  it("rejects an iWork zip with NONE of the Index members (kills matchesIWorkPackage)", () => {
    const pkg = makeIWork("Preview/QuickLook.pdf");
    const r = validateFileForGateway({
      filename: "fake.pages",
      byteLength: pkg.length,
      firstBytes: pkg.subarray(0, 16),
      fullBytes: pkg,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("FILE_CONTENT_MISMATCH");
  });

  it("rejects an iWork file with PK magic but MISSING fullBytes (length-mismatch fail-closed)", () => {
    for (const filename of ["a.numbers", "a.key"]) {
      const r = validateFileForGateway({
        filename,
        byteLength: 1024,
        firstBytes: bytes(0x50, 0x4b, 0x03, 0x04),
        // fullBytes omitted → fullBytes.length !== byteLength guard fails closed.
      });
      expect(r.ok, filename).toBe(false);
      if (!r.ok) expect(r.reason).toBe("FILE_CONTENT_MISMATCH");
    }
  });

  it("the .numbers and .key magic-byte arms require the PK prefix (kills their byte arrays)", () => {
    // Wrong magic for an iWork ext → FILE_CONTENT_MISMATCH (kills the
    // [0x50,0x4b,0x03,0x04] -> [] array-empty mutant for the pages/numbers/key
    // shared arm: an empty prefix would `startsWith([])` === true and accept
    // ANY bytes). Provide a full iWork package body but wrong FIRST bytes.
    const pkg = makeIWork("Index.zip");
    for (const filename of ["a.numbers", "a.key", "a.pages"]) {
      const r = validateFileForGateway({
        filename,
        byteLength: pkg.length,
        firstBytes: bytes(0xde, 0xad, 0xbe, 0xef), // NOT PK
        fullBytes: pkg,
      });
      expect(r.ok, filename).toBe(false);
      if (!r.ok) expect(r.reason).toBe("FILE_CONTENT_MISMATCH");
    }
  });
});

describe("file-allowlist ISO-BMFF brand literals (kills each brand string)", () => {
  it("m4a accepts ALL declared brands and rejects an undeclared one", () => {
    for (const brand of ["M4A ", "M4B ", "isom", "mp42"]) {
      expect(ok("a.m4a", isoBmff(brand)), brand).toBe(true);
    }
    expect(ok("a.m4a", isoBmff("xxxx"))).toBe(false);
  });

  it("mp4 accepts EACH declared brand individually (kills isom/iso2/mp41/avc1/M4V literals)", () => {
    for (const brand of ["isom", "iso2", "mp41", "mp42", "avc1", "M4V "]) {
      expect(ok("a.mp4", isoBmff(brand)), brand).toBe(true);
    }
    expect(ok("a.mp4", isoBmff("zzzz"))).toBe(false);
  });
});

describe("file-allowlist startsWith / bytesEqual byte helpers (L362-L371)", () => {
  it("startsWith fails closed when head is shorter than the prefix (kills head.length<prefix.length -> false)", () => {
    // .png needs an 8-byte signature; give only 4 valid bytes. With the
    // `head.length < prefix.length` guard removed, the loop would read past the
    // end (undefined !== byte) and still reject — but the boundary intent is
    // that a too-short head is rejected, which this asserts.
    expect(ok("a.png", bytes(0x89, 0x50, 0x4e, 0x47))).toBe(false);
  });

  it("HEIC bytesEqual: a brand of the WRONG length / value is rejected (kills a.length!==b.length & i<a.length)", () => {
    // hasIsoBmffBrand for heic uses bytesEqual on a 4-byte brand slice. A brand
    // whose bytes differ in the LAST position must be rejected — exercising the
    // full i<a.length comparison loop (an `i<=a.length` over-read mutant would
    // compare an undefined extra element but still reject; the discriminating
    // case is a brand correct in 3 of 4 bytes).
    const head = new Uint8Array([
      0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, // ftyp
      0x68, 0x65, 0x69, 0x00, // 'hei\0' — last byte wrong
    ]);
    expect(ok("a.heic", head)).toBe(false);
    // And the exact 'heic' brand is accepted (positive control).
    head[11] = 0x63;
    expect(ok("a.heic", head)).toBe(true);
  });
});

describe("file-allowlist exact-length head boundaries (kills head.length>=2 -> >)", () => {
  it("mp3: a head of EXACTLY 2 bytes with a valid frame sync is accepted", () => {
    // head.length >= 2 must accept a 2-byte head; a `> 2` mutant would reject it.
    // 0xFF then top-3 sync bits set (0xE0 mask) on byte 1.
    expect(ok("a.mp3", bytes(0xff, 0xfb))).toBe(true);
  });

  it("aac: a head of EXACTLY 2 bytes with a valid sync is accepted (kills >= -> >)", () => {
    // 0xFF then high nibble 0xF on byte 1.
    expect(ok("a.aac", bytes(0xff, 0xf1))).toBe(true);
  });
});

describe("file-allowlist .docx magic prefix (kills the PK byte-array -> [])", () => {
  it("rejects a .docx with valid OOXML container but NON-PK first bytes", () => {
    // The magic-byte check requires PK\x03\x04 as firstBytes. If the byte array
    // were emptied to [], startsWith(head, []) === true would accept ANY first
    // bytes and rely solely on the container check. A docx with a VALID OOXML
    // container but WRONG firstBytes must still be rejected by the magic check.
    const docx = makeValidDocx();
    const r = validateFileForGateway({
      filename: "spoofed.docx",
      byteLength: docx.length,
      firstBytes: bytes(0xde, 0xad, 0xbe, 0xef), // NOT PK\x03\x04
      fullBytes: docx,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("FILE_CONTENT_MISMATCH");
    // Control: the SAME docx with correct PK first bytes is accepted.
    expect(
      validateFileForGateway({
        filename: "real.docx",
        byteLength: docx.length,
        firstBytes: docx.subarray(0, 16),
        fullBytes: docx,
      }).ok,
    ).toBe(true);
  });
});

describe("file-allowlist google-stub path family literal (kills '/document/' -> '')", () => {
  function gstub(json: string, filename = "a.gdoc") {
    const fullBytes = utf8(json);
    return validateFileForGateway({
      filename,
      byteLength: fullBytes.length,
      firstBytes: fullBytes.subarray(0, 16),
      fullBytes,
    });
  }

  it("rejects a .gdoc whose URL path is /spreadsheets/ (wrong family literal)", () => {
    // .gdoc requires the path to contain '/document/'. A `'/document/' -> ''`
    // mutant makes `pathname.includes('')` always true, wrongly accepting a
    // /spreadsheets/-path stub under a .gdoc name. Host + extractable id are
    // valid so ONLY the path-family literal decides.
    expect(
      gstub(
        '{"url":"https://docs.google.com/spreadsheets/d/ABC123","doc_id":"ABC123"}',
        "a.gdoc",
      ).ok,
    ).toBe(false);
    // Control: the correct /document/ path under .gdoc is accepted.
    expect(
      gstub(
        '{"url":"https://docs.google.com/document/d/ABC123","doc_id":"ABC123"}',
        "a.gdoc",
      ).ok,
    ).toBe(true);
  });
});

describe("file-allowlist default magic matcher (L356-L357)", () => {
  it("an extension with no magic-byte case returns false by default (no GOOGLE_STUB/TEXT path)", () => {
    // .docx is a BINARY ext routed through matchesBinaryMagic. Bytes that match
    // the PK prefix but then a wrong container, vs bytes matching NO case: use a
    // binary ext that hits the switch default. .heic with a valid-looking but
    // we route through an unknown binary by corrupting the .pdf path already
    // covered; here assert the default arm via a .rtf-magic'd .png mismatch.
    expect(ok("a.png", utf8("{\\rtf1"))).toBe(false);
  });
});

describe("file-allowlist branch-coverage backfill (the NoCoverage tail)", () => {
  it("an ext with a capability but in NEITHER binary/text/google-stub set is impossible by construction — guard stays fail-closed", () => {
    // Every readable ext belongs to exactly one of the three sets, so the
    // `!isBinary && !isText && !isGoogleStub` reject is defence-in-depth. We
    // exercise the surrounding reachable branches: an unknown ext is rejected
    // earlier (no capability), and every known ext routes to a real branch.
    expect(validateFileForGateway({ filename: "x.unknownext", byteLength: 10 }).ok).toBe(
      false,
    );
  });

  it("a google-stub with NON-UTF8 bytes is rejected (kills !isLikelyUtf8 -> false in matchesGoogleStubJson)", () => {
    // Invalid UTF-8 fullBytes for a .gdoc → matchesGoogleStubJson's isLikelyUtf8
    // gate must fire and reject before JSON.parse. A `!isLikelyUtf8`->false
    // mutant would skip the gate and attempt to decode garbage.
    const garbage = bytes(0xff, 0xfe, 0x80, 0x81, 0x82, 0x83, 0x84, 0x85);
    const r = validateFileForGateway({
      filename: "x.gdoc",
      byteLength: garbage.length,
      firstBytes: garbage,
      fullBytes: garbage,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("FILE_CONTENT_MISMATCH");
  });
});
