import { describe, it, expect } from "vitest";

import {
  MAX_FILE_BYTES,
  isAllowedGatewayExtension,
  validateFileForGateway,
} from "../tools/file-allowlist";

function bytes(...vals: number[]): Uint8Array {
  return new Uint8Array(vals);
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function isoBmff(brand: string): Uint8Array {
  return new Uint8Array([
    0x00,
    0x00,
    0x00,
    0x18,
    0x66,
    0x74,
    0x79,
    0x70,
    ...new TextEncoder().encode(brand.slice(0, 4)),
  ]);
}

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

function storedZip(entries: Array<{ name: string; body: Uint8Array }>): Uint8Array {
  const locals: Uint8Array[] = [];
  const centralEntries: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = utf8(entry.name);
    const crc = crc32(entry.body);
    const local = new Uint8Array(30 + nameBytes.length + entry.body.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, entry.body.length, true);
    localView.setUint32(22, entry.body.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(entry.body, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, entry.body.length, true);
    centralView.setUint32(24, entry.body.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralEntries.push(central);
    offset += local.length;
  }
  const cdStart = offset;
  const cdLength = centralEntries.reduce((sum, entry) => sum + entry.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, cdLength, true);
  eocdView.setUint32(16, cdStart, true);
  const out = new Uint8Array(cdStart + cdLength + eocd.length);
  let p = 0;
  for (const local of locals) {
    out.set(local, p);
    p += local.length;
  }
  for (const central of centralEntries) {
    out.set(central, p);
    p += central.length;
  }
  out.set(eocd, p);
  return out;
}

describe("validateFileForGateway", () => {
  it("accepts PDF with %PDF- magic", () => {
    const r = validateFileForGateway({
      filename: "offer.pdf",
      mimeType: "application/pdf",
      byteLength: 1024,
      firstBytes: utf8("%PDF-1.7\n%"),
    });
    expect(r.ok).toBe(true);
  });

  it("accepts plain text and markdown via UTF-8 check", () => {
    expect(
      validateFileForGateway({
        filename: "notes.md",
        mimeType: "text/markdown",
        byteLength: 64,
        firstBytes: utf8("# Hello world"),
      }).ok,
    ).toBe(true);
    expect(
      validateFileForGateway({
        filename: "notes.txt",
        mimeType: "text/plain",
        byteLength: 64,
        firstBytes: utf8("plain ASCII text"),
      }).ok,
    ).toBe(true);
  });

  it("accepts JSON / YAML via UTF-8 check", () => {
    expect(
      validateFileForGateway({
        filename: "data.json",
        mimeType: "application/json",
        byteLength: 64,
        firstBytes: utf8('{"ok":true}'),
      }).ok,
    ).toBe(true);
    expect(
      validateFileForGateway({
        filename: "config.yaml",
        byteLength: 64,
        firstBytes: utf8("foo: bar\n"),
      }).ok,
    ).toBe(true);
  });

  it("accepts TS/TSX/JS/PY source", () => {
    for (const [name, body] of [
      ["main.ts", "export const x = 1;"],
      ["component.tsx", "export const C = () => null;"],
      ["index.js", "module.exports = {};"],
      ["script.py", "print('hi')"],
    ] as const) {
      const r = validateFileForGateway({
        filename: name,
        byteLength: body.length,
        firstBytes: utf8(body),
      });
      expect(r.ok, name).toBe(true);
    }
  });

  it("accepts PNG / JPEG / HEIC by magic bytes", () => {
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    expect(
      validateFileForGateway({
        filename: "page.png",
        mimeType: "image/png",
        byteLength: 1024,
        firstBytes: bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
      }).ok,
    ).toBe(true);
    // JPEG: FF D8 FF
    expect(
      validateFileForGateway({
        filename: "snap.jpg",
        mimeType: "image/jpeg",
        byteLength: 1024,
        firstBytes: bytes(0xff, 0xd8, 0xff, 0xe0),
      }).ok,
    ).toBe(true);
    // HEIC: ISO BMFF, starts with size bytes + 'ftypheic' or 'ftypheix' at offset 4
    expect(
      validateFileForGateway({
        filename: "photo.heic",
        mimeType: "image/heic",
        byteLength: 2048,
        firstBytes: bytes(
          0x00,
          0x00,
          0x00,
          0x20,
          0x66,
          0x74,
          0x79,
          0x70,
          0x68,
          0x65,
          0x69,
          0x63,
        ),
      }).ok,
    ).toBe(true);
  });

  it(".docx is now accepted with full OOXML container validation (sister of ooxml-validator.test.ts integration tests)", () => {
    // .docx now passes the gateway IFF the full bytes parse as a
    // valid OOXML container ([Content_Types].xml + _rels/.rels +
    // word/document.xml + wordprocessingml content-type declaration).
    // This test only verifies the magic-byte-without-fullBytes path
    // fails closed; the positive case is covered by the dedicated
    // ooxml-validator.test.ts which constructs a real .docx ZIP.
    const r = validateFileForGateway({
      filename: "draft.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      byteLength: 4096,
      firstBytes: bytes(0x50, 0x4b, 0x03, 0x04),
      // fullBytes deliberately omitted → fail closed.
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("FILE_CONTENT_MISMATCH");
  });

  it("accepts RTF via magic-byte check", () => {
    // RTF starts with {\rtf — this is a real format signature, not a
    // generic container header.
    expect(
      validateFileForGateway({
        filename: "memo.rtf",
        mimeType: "application/rtf",
        byteLength: 256,
        firstBytes: utf8("{\\rtf1\\ansi"),
      }).ok,
    ).toBe(true);
  });

  it("accepts Google document stubs as small UTF-8 JSON files", () => {
    const fullBytes = utf8(
      '{"url":"https://docs.google.com/document/d/example","doc_id":"example"}',
    );

    const r = validateFileForGateway({
      filename: "brief.gdoc",
      byteLength: fullBytes.length,
      firstBytes: fullBytes.subarray(0, 16),
      fullBytes,
    });

    expect(r.ok).toBe(true);
  });

  it("rejects malformed Google document stubs", () => {
    const fullBytes = utf8("not-json");

    const r = validateFileForGateway({
      filename: "brief.gdoc",
      byteLength: fullBytes.length,
      firstBytes: fullBytes,
      fullBytes,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("FILE_CONTENT_MISMATCH");
  });

  it("rejects Google stubs that lack a docs.google.com URL and resource id", () => {
    for (const fullBytes of [
      utf8('{"foo":"bar"}'),
      utf8('{"url":"https://example.com/document/d/abc","doc_id":"abc"}'),
      utf8('{"url":"https://docs.google.com/document/u/0/"}'),
    ]) {
      const r = validateFileForGateway({
        filename: "brief.gdoc",
        byteLength: fullBytes.length,
        firstBytes: fullBytes.subarray(0, 16),
        fullBytes,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("FILE_CONTENT_MISMATCH");
    }
  });

  it("requires full iWork package bytes for structural validation", () => {
    for (const filename of ["draft.pages", "model.numbers", "deck.key"]) {
      const r = validateFileForGateway({
        filename,
        byteLength: 1024,
        firstBytes: bytes(0x50, 0x4b, 0x03, 0x04),
      });
      expect(r.ok, filename).toBe(false);
      if (!r.ok) expect(r.reason).toBe("FILE_CONTENT_MISMATCH");
    }
  });

  it("accepts iWork packages with an Index payload and rejects renamed preview-only zips", () => {
    const valid = storedZip([{ name: "Index.zip", body: utf8("PK\u0003\u0004") }]);
    const previewOnly = storedZip([
      { name: "QuickLook/Preview.pdf", body: utf8("%PDF-1.4\n") },
    ]);

    expect(
      validateFileForGateway({
        filename: "draft.pages",
        byteLength: valid.length,
        firstBytes: valid.subarray(0, 16),
        fullBytes: valid,
      }).ok,
    ).toBe(true);
    const renamed = validateFileForGateway({
      filename: "draft.pages",
      byteLength: previewOnly.length,
      firstBytes: previewOnly.subarray(0, 16),
      fullBytes: previewOnly,
    });
    expect(renamed.ok).toBe(false);
    if (!renamed.ok) expect(renamed.reason).toBe("FILE_CONTENT_MISMATCH");
  });

  it("accepts common audio and video container signatures", () => {
    const cases: Array<[string, Uint8Array]> = [
      ["voice.mp3", utf8("ID3\u0004")],
      ["voice.wav", utf8("RIFFxxxxWAVE")],
      ["voice.m4a", isoBmff("M4A ")],
      ["voice.flac", utf8("fLaC")],
      ["voice.ogg", utf8("OggS")],
      ["clip.mp4", isoBmff("mp42")],
      ["clip.mov", isoBmff("qt  ")],
      ["clip.webm", bytes(0x1a, 0x45, 0xdf, 0xa3)],
      ["clip.mkv", bytes(0x1a, 0x45, 0xdf, 0xa3)],
    ];

    for (const [filename, firstBytes] of cases) {
      const r = validateFileForGateway({
        filename,
        byteLength: 1024,
        firstBytes,
      });
      expect(r.ok, filename).toBe(true);
    }
  });

  it("rejects extension-spoofed media content", () => {
    for (const filename of ["voice.mp3", "clip.mp4", "deck.key"]) {
      const r = validateFileForGateway({
        filename,
        byteLength: 1024,
        firstBytes: utf8("plain text"),
      });
      expect(r.ok, filename).toBe(false);
      if (!r.ok) expect(r.reason).toBe("FILE_CONTENT_MISMATCH");
    }
  });

  it("allows every shared readable extension name at list time", () => {
    for (const filename of [
      "resume.docx",
      "paper.pdf",
      "notes.rtf",
      "draft.pages",
      "doc.gdoc",
      "image.png",
      "voice.mp3",
      "clip.mp4",
    ]) {
      expect(isAllowedGatewayExtension(filename), filename).toBe(true);
    }
  });

  it.each(["payload.exe", "thing.sh", "evil.bin", "archive.zip", "image.svg"])(
    "rejects extension %s",
    (name) => {
      const r = validateFileForGateway({
        filename: name,
        byteLength: 1024,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("FILE_TYPE_NOT_ALLOWED");
    },
  );

  it("rejects extension-stripped filenames (no dot)", () => {
    const r = validateFileForGateway({
      filename: "Makefile",
      byteLength: 100,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("FILE_TYPE_NOT_ALLOWED");
  });

  it("rejects files larger than 5 MB", () => {
    const r = validateFileForGateway({
      filename: "big.pdf",
      byteLength: MAX_FILE_BYTES + 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("FILE_TOO_LARGE");
  });

  it("rejects extension-spoofed binary (PDF name, MZ bytes)", () => {
    const r = validateFileForGateway({
      filename: "malware.pdf",
      mimeType: "application/x-msdownload",
      byteLength: 1024,
      firstBytes: bytes(0x4d, 0x5a, 0x90, 0x00),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("FILE_CONTENT_MISMATCH");
  });

  it("rejects PNG name with wrong magic bytes", () => {
    const r = validateFileForGateway({
      filename: "fake.png",
      mimeType: "image/png",
      byteLength: 1024,
      firstBytes: bytes(0x00, 0x00, 0x00, 0x00),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("FILE_CONTENT_MISMATCH");
  });

  it("rejects text-type files with invalid UTF-8 in the head", () => {
    const r = validateFileForGateway({
      filename: "evil.md",
      mimeType: "text/markdown",
      byteLength: 64,
      // Lone continuation byte 0x80 — invalid UTF-8 start
      firstBytes: bytes(0x80, 0x81, 0x82),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("FILE_CONTENT_MISMATCH");
  });

  it("treats firstBytes-absent as acceptable for text/code (best-effort, byteLength still capped)", () => {
    // When the client did not include a head sample, the gateway should
    // still accept (the read tools always populate firstBytes; this branch
    // covers list-only responses where content has not been fetched yet).
    const r = validateFileForGateway({
      filename: "list-only.md",
      byteLength: 1024,
    });
    expect(r.ok).toBe(true);
  });

  it("requires firstBytes for binary formats (cannot trust extension alone)", () => {
    const r = validateFileForGateway({
      filename: "trustme.pdf",
      byteLength: 1024,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("FILE_CONTENT_MISMATCH");
  });

  it("rejects otherwise-valid files outside an explicit capability suite", () => {
    const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    const r = validateFileForGateway({
      filename: "photo.png",
      byteLength: png.length,
      firstBytes: png,
      capabilitySuiteIds: ["text"],
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("FILE_TYPE_NOT_ALLOWED");
    expect(
      validateFileForGateway({
        filename: "photo.png",
        byteLength: png.length,
        firstBytes: png,
        capabilitySuiteIds: ["image"],
      }).ok,
    ).toBe(true);
  });

  it("MAX_FILE_BYTES is 5 MiB (spec §7.1) — chunked tool-result transport glues multi-frame wire posts back together", () => {
    expect(MAX_FILE_BYTES).toBe(5 * 1024 * 1024);
  });
});
