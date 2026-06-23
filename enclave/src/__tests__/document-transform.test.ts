import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { extractDocxPlainText, validateDocxContainer } from "../tools/ooxml-validator";
import { MediaToolsClient } from "../tools/media-tools";

// These tests spawn the Python media sidecar (MediaToolsClient.start()), whose
// readiness wait imports heavy deps (Pillow / PyMuPDF) — the same cold-start
// that media-tools.test.ts documents as exceeding vitest's default 5s test
// timeout on a loaded CI runner (the client's timeoutMs only bounds run(), not
// start()). The PyMuPDF cases are skipped locally but run in CI where fitz is
// installed. Give the whole file a generous timeout so the cold spawn cannot
// flake. Matches media-tools.test.ts / tier-a-read.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const servicePath = resolve(
  import.meta.dirname ?? __dirname,
  "../tools/media_tools_service.py",
);

function makeDocxB64(text: string): string {
  return execFileSync("python3", [
    "-c",
    `
import base64, io, zipfile, html, sys
text = sys.argv[1]
buf = io.BytesIO()
content_types = '''<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'''
rels = '''<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'''
doc = f'''<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{html.escape(text)}</w:t></w:r></w:p></w:body></w:document>'''
with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", content_types)
    z.writestr("_rels/.rels", rels)
    z.writestr("word/document.xml", doc)
print(base64.b64encode(buf.getvalue()).decode("ascii"))
`,
    text,
  ])
    .toString("utf8")
    .trim();
}

const hasPyMuPdf =
  spawnSync("python3", ["-c", "import fitz"], { stdio: "ignore" }).status === 0;

describe("document transforms", () => {
  it("replaces bounded text in a DOCX and returns a valid DOCX copy", async () => {
    const client = new MediaToolsClient({ scriptPath: servicePath, timeoutMs: 5_000 });
    await client.start();
    const result = await client.run({
      operation: "document.docx_transform",
      filename: "resume.docx",
      inputB64: makeDocxB64("Jane Developer"),
      transform: {
        kind: "replace_text",
        search: "Jane Developer",
        replacement: "Avery Engineer",
        maxReplacements: 1,
      },
    } as never);
    client.stop();

    expect(result.outputExtension).toBe(".docx");
    const output = Buffer.from(result.outputB64!, "base64");
    expect(validateDocxContainer(output)).toEqual({ ok: true });
    expect(extractDocxPlainText(output)).toMatchObject({
      ok: true,
      text: "Avery Engineer",
    });
    expect(output.equals(Buffer.from(makeDocxB64("Jane Developer"), "base64"))).toBe(false);
  });

  it("appends a section to a DOCX without dropping existing package relationships", async () => {
    const client = new MediaToolsClient({ scriptPath: servicePath, timeoutMs: 5_000 });
    await client.start();
    const result = await client.run({
      operation: "document.docx_transform",
      filename: "notes.docx",
      inputB64: makeDocxB64("Original section"),
      transform: {
        kind: "append_section",
        heading: "Follow up",
        body: "Call the client tomorrow.",
      },
    } as never);
    client.stop();

    const output = Buffer.from(result.outputB64!, "base64");
    expect(validateDocxContainer(output)).toEqual({ ok: true });
    const text = extractDocxPlainText(output);
    expect(text).toMatchObject({ ok: true });
    if (text.ok) {
      expect(text.text).toContain("Original section");
      expect(text.text).toContain("Follow up");
      expect(text.text).toContain("Call the client tomorrow.");
    }
  });

  it("rejects native iWork editing explicitly", async () => {
    const client = new MediaToolsClient({ scriptPath: servicePath, timeoutMs: 5_000 });
    await client.start();
    await expect(
      client.run({
        operation: "document.docx_transform",
        filename: "deck.key",
        inputB64: Buffer.from("iwork").toString("base64"),
        transform: { kind: "append_section", heading: "x", body: "y" },
      } as never),
    ).rejects.toThrow(/IWORK_NATIVE_EDIT_UNSUPPORTED|MEDIA_TOOL_ERROR/);
    client.stop();
  });

  (hasPyMuPdf ? it : it.skip)("redacts text in PDF raw objects", async () => {
    const pdfB64 = execFileSync("python3", [
      "-c",
      `
import base64, io, fitz
doc = fitz.open()
p = doc.new_page()
p.insert_text((72, 72), "SecretCode42")
data = doc.tobytes()
print(base64.b64encode(data).decode("ascii"))
`,
    ])
      .toString("utf8")
      .trim();
    const client = new MediaToolsClient({ scriptPath: servicePath, timeoutMs: 5_000 });
    await client.start();
    const result = await client.run({
      operation: "document.pdf_transform",
      filename: "secret.pdf",
      inputB64: pdfB64,
      transform: {
        kind: "redact_text",
        search: "SecretCode42",
        maxReplacements: 2,
      },
    } as never);
    client.stop();

    const output = Buffer.from(result.outputB64!, "base64");
    expect(output.slice(0, 5).toString("utf8")).toBe("%PDF-");
    expect(output.toString("latin1")).not.toContain("SecretCode42");
  });

  // GitHub AI finding: the redact_text post-check used to scan the raw
  // *compressed* output bytes (`search.encode() in out`). Under deflate the
  // text is compressed away, so that scan was blind to a surviving redaction
  // (false assurance) and could false-positive on uncompressed metadata. The
  // verdict now comes from a pure, PDF-engine-free policy. This test enforces
  // that policy's truth table in CI (python3 only, no PyMuPDF required, since
  // `import fitz` is lazy inside pdf_transform).
  it("redaction verification policy rejects only when the output still leaks the term", () => {
    const out = execFileSync("python3", [
      "-c",
      `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("mts", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
f = m.redaction_output_acceptable
# (before, after, redacted) -> acceptable?
cases = [
    ((0, 0, 0), True),   # nothing to redact
    ((1, 0, 1), True),   # full removal
    ((2, 1, 1), True),   # partial by maxReplacements
    ((1, 1, 1), False),  # no-op redaction (the silent-failure mode)
    ((2, 2, 1), False),  # under-redaction
    ((1, 0, 2), True),   # geometry over-count must not false-positive
]
bad = [(c, exp, f(*c)) for c, exp in cases if f(*c) != exp]
print("OK" if not bad else "BAD:" + repr(bad))
`,
      servicePath,
    ])
      .toString("utf8")
      .trim();
    expect(out).toBe("OK");
  });

  (hasPyMuPdf ? it : it.skip)(
    "redaction removes the term from the DECODED page text (not just raw bytes)",
    async () => {
      const pdfB64 = execFileSync("python3", [
        "-c",
        `
import base64, fitz
doc = fitz.open()
p = doc.new_page()
p.insert_text((72, 72), "PatientName Acme")
data = doc.tobytes()
print(base64.b64encode(data).decode("ascii"))
`,
      ])
        .toString("utf8")
        .trim();
      const client = new MediaToolsClient({ scriptPath: servicePath, timeoutMs: 5_000 });
      await client.start();
      const result = await client.run({
        operation: "document.pdf_transform",
        filename: "phi.pdf",
        inputB64: pdfB64,
        transform: { kind: "redact_text", search: "PatientName", maxReplacements: 2 },
      } as never);
      client.stop();

      // Re-extract DECODED text from the output and assert the term is gone —
      // this is the guarantee the old raw-byte scan could not actually verify.
      const remaining = execFileSync("python3", [
        "-c",
        `
import base64, sys, fitz
d = fitz.open(stream=base64.b64decode(sys.argv[1]), filetype="pdf")
print("".join(pg.get_text() for pg in d).count("PatientName"))
`,
        result.outputB64!,
      ])
        .toString("utf8")
        .trim();
      expect(remaining).toBe("0");
    },
  );
});
