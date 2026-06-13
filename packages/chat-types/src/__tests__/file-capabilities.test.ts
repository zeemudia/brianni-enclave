import { describe, expect, it } from "vitest";

import {
  FILE_CAPABILITY_FAMILIES,
  getCapabilityForExtension,
  getReadableExtensions,
} from "../file-capabilities";

describe("file capability registry", () => {
  it("covers the requested linked-folder file families", () => {
    expect(FILE_CAPABILITY_FAMILIES.map((family) => family.id).sort()).toEqual(
      [
        "apple-iwork",
        "audio",
        "google-stub",
        "image",
        "office-document",
        "pdf",
        "rtf",
        "text",
        "video",
      ],
    );
  });

  it("marks text formats as readable, understandable, and text-writable", () => {
    const md = getCapabilityForExtension(".md");

    expect(md?.listRead).toBe("supported");
    expect(md?.understand).toBe("plain-text");
    expect(md?.write).toBe("native-text");
  });

  it("treats csv/tsv as plain text (bank-export regression, 2026-06-12)", () => {
    for (const ext of [".csv", ".tsv"]) {
      const cap = getCapabilityForExtension(ext);
      expect(cap?.id, ext).toBe("text");
      expect(cap?.listRead, ext).toBe("supported");
      expect(cap?.understand, ext).toBe("plain-text");
    }
  });

  it("marks proprietary and cloud stubs honestly", () => {
    expect(getCapabilityForExtension(".pages")?.understand).toBe(
      "preview-or-export",
    );
    expect(getCapabilityForExtension(".gdoc")?.understand).toBe(
      "requires-google-export",
    );
    expect(getCapabilityForExtension(".pages")?.write).toBe("derived-output");
    expect(getCapabilityForExtension(".gdoc")?.write).toBe("derived-output");
  });

  it("advertises implemented media extractor and transform tools", () => {
    expect(getCapabilityForExtension(".png")).toMatchObject({
      id: "image",
      listRead: "supported",
      understand: "ocr",
      write: "bounded-transform",
    });
    expect(getCapabilityForExtension(".mp3")).toMatchObject({
      id: "audio",
      understand: "transcript",
      write: "bounded-transform",
    });
    expect(getCapabilityForExtension(".mp4")).toMatchObject({
      id: "video",
      understand: "transcript",
      write: "bounded-transform",
    });
  });

  it("advertises bounded binary transforms for DOCX and PDF", () => {
    expect(getCapabilityForExtension(".docx")?.write).toBe(
      "bounded-transform",
    );
    expect(getCapabilityForExtension(".pdf")?.write).toBe(
      "bounded-transform",
    );
  });

  it("keeps binary capability size claims within the implemented linked-folder bridge budget", () => {
    for (const ext of [".pages", ".png", ".mp3", ".mp4"]) {
      expect(getCapabilityForExtension(ext)?.maxBytes).toBe(5 * 1024 * 1024);
    }
  });

  it("looks up extensions case-insensitively", () => {
    expect(getCapabilityForExtension(".PDF")?.id).toBe("pdf");
  });

  it("includes all readable extensions for client pickers", () => {
    expect(getReadableExtensions()).toEqual(
      expect.arrayContaining([
        ".txt",
        ".md",
        ".docx",
        ".pdf",
        ".rtf",
        ".pages",
        ".numbers",
        ".key",
        ".gdoc",
        ".gsheet",
        ".gslides",
        ".png",
        ".jpg",
        ".jpeg",
        ".heic",
        ".mp3",
        ".wav",
        ".m4a",
        ".mp4",
        ".mov",
      ]),
    );
  });
});
