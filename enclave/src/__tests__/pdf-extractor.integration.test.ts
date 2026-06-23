import { describe, expect, it, vi } from "vitest";

import { extractPdfPlainText } from "../tools/pdf-extractor";

// This test exercises the REAL pdfjs path: it dynamically imports the ~1 MB
// pdfjs-dist legacy build and parses a PDF. The cold import cost is highly
// variable (≈200ms warm to ≈1s+ cold locally, well past 5s on a contended CI
// runner) and the extractor's own internal deadline is 10s — both larger than
// vitest's default 5s budget. Give the file a generous timeout so a slow cold
// import under CI load cannot flake. Matches tier-a-read / media-tools.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function pdfEscape(value: string): string {
  return value.replace(/([\\()])/g, "\\$1");
}

function makeMinimalPdfWithText(text: string): Uint8Array {
  const stream = `BT /F1 24 Tf 72 720 Td (${pdfEscape(text)}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return utf8(pdf);
}

describe("extractPdfPlainText real pdfjs integration", () => {
  it("loads pdfjs-dist and extracts text from a tiny searchable PDF", async () => {
    const result = await extractPdfPlainText(
      makeMinimalPdfWithText("Hello from real pdfjs"),
    );

    expect(result?.text).toContain("Hello from real pdfjs");
    expect(result?.truncated).toBe(false);
  });
});
