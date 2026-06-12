import { describe, expect, it } from "vitest";

import {
  resolveClientWrittenPath,
  resolveCopyOutputPath,
} from "../tools/copy-on-write-policy";

describe("copy-on-write policy", () => {
  it("allocates a distinct output path when the requested path equals the source", () => {
    const result = resolveCopyOutputPath({
      sourcePath: "resume.docx",
      requestedOutputPath: "resume.docx",
      existingPaths: ["resume.docx"],
    });

    expect(result).toEqual({
      ok: true,
      requestedOutputPath: "resume.docx",
      outputPath: "resume copy.docx",
      pathAdjusted: true,
    });
  });

  it("allocates a suffixed path when the requested output already exists", () => {
    const result = resolveCopyOutputPath({
      sourcePath: "resume.docx",
      requestedOutputPath: "resume_ATS.md",
      existingPaths: ["resume.docx", "resume_ATS.md"],
    });

    expect(result).toEqual({
      ok: true,
      requestedOutputPath: "resume_ATS.md",
      outputPath: "resume_ATS 2.md",
      pathAdjusted: true,
    });
  });

  it("accepts a distinct non-existing copy path", () => {
    const result = resolveCopyOutputPath({
      sourcePath: "resume.docx",
      requestedOutputPath: "resume_ATS.md",
      existingPaths: ["resume.docx"],
    });

    expect(result).toEqual({
      ok: true,
      requestedOutputPath: "resume_ATS.md",
      outputPath: "resume_ATS.md",
      pathAdjusted: false,
    });
  });

  it("accepts the exact numeric suffix grammar used by web and mobile writers", () => {
    const bases = ["notes.md", "notes 2.md", "report 5.docx", "draft 99.txt"];
    for (const base of bases) {
      for (let index = 2; index <= 101; index += 1) {
        const writtenPath = withNumericSuffix(base, index);
        const result = resolveClientWrittenPath({
          requestedOutputPath: base,
          enclaveOutputPath: base,
          writtenPath,
        });

        expect(result, `${base} -> ${writtenPath}`).toEqual({
          ok: true,
          writtenPath,
          pathAdjusted: true,
        });
      }
    }
  });

  it("accepts a client-side second suffix after the enclave already adjusted the path", () => {
    const result = resolveClientWrittenPath({
      requestedOutputPath: "notes.md",
      enclaveOutputPath: "notes 2.md",
      writtenPath: "notes 2 2.md",
    });

    expect(result).toEqual({
      ok: true,
      writtenPath: "notes 2 2.md",
      pathAdjusted: true,
    });
  });
});

function withNumericSuffix(path: string, index: number): string {
  const dot = path.lastIndexOf(".");
  if (dot <= 0) return `${path} ${index}`;
  return `${path.slice(0, dot)} ${index}${path.slice(dot)}`;
}
