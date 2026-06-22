import { describe, expect, it } from "vitest";

import {
  CapabilityStatusSchema,
  FILE_CAPABILITY_FAMILIES,
  FileCapabilityFamilyIdSchema,
  getCapabilityForExtension,
  getReadableExtensions,
} from "../file-capabilities";

// Mutation-hardening for the file-capability registry. The capability table is
// the on-device contract for what the agent's file tools advertise (list/read,
// understand, write) and the per-family byte budget. A mutated capability string
// or maxBytes would mis-advertise a tool (e.g. claim "supported" for a format the
// bridge can't read, or raise a size budget past the bridge's limit). Each
// extension's StringLiteral is pinned by an exact per-extension lookup so a
// dropped extension is observably killed.

// The authoritative expected shape per family (mirrors file-capabilities.ts).
const EXPECTED = [
  {
    id: "text",
    extensions: [
      ".txt", ".md", ".ts", ".tsx", ".js", ".jsx", ".py", ".json", ".yaml",
      ".yml", ".csv", ".tsv",
    ],
    listRead: "supported",
    understand: "plain-text",
    write: "native-text",
    maxBytes: 5 * 1024 * 1024,
  },
  {
    id: "office-document",
    extensions: [".docx"],
    listRead: "supported",
    understand: "extracted-text",
    write: "bounded-transform",
    maxBytes: 5 * 1024 * 1024,
  },
  {
    id: "pdf",
    extensions: [".pdf"],
    listRead: "supported",
    understand: "extracted-text",
    write: "bounded-transform",
    maxBytes: 5 * 1024 * 1024,
  },
  {
    id: "rtf",
    extensions: [".rtf"],
    listRead: "supported",
    understand: "extracted-text",
    write: "native-text",
    maxBytes: 5 * 1024 * 1024,
  },
  {
    id: "apple-iwork",
    extensions: [".pages", ".numbers", ".key"],
    listRead: "supported",
    understand: "preview-or-export",
    write: "derived-output",
    maxBytes: 5 * 1024 * 1024,
  },
  {
    id: "google-stub",
    extensions: [".gdoc", ".gsheet", ".gslides"],
    listRead: "supported",
    understand: "requires-google-export",
    write: "derived-output",
    maxBytes: 128 * 1024,
  },
  {
    id: "image",
    extensions: [".png", ".jpg", ".jpeg", ".heic"],
    listRead: "supported",
    understand: "ocr",
    write: "bounded-transform",
    maxBytes: 5 * 1024 * 1024,
  },
  {
    id: "audio",
    extensions: [".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"],
    listRead: "supported",
    understand: "transcript",
    write: "bounded-transform",
    maxBytes: 5 * 1024 * 1024,
  },
  {
    id: "video",
    extensions: [".mp4", ".mov", ".webm", ".mkv"],
    listRead: "supported",
    understand: "transcript",
    write: "bounded-transform",
    maxBytes: 5 * 1024 * 1024,
  },
] as const;

describe("file-capability registry — exhaustive table pin", () => {
  it("declares exactly the expected families in order", () => {
    expect(FILE_CAPABILITY_FAMILIES.map((f) => f.id)).toEqual(
      EXPECTED.map((f) => f.id),
    );
  });

  for (const fam of EXPECTED) {
    describe(`family ${fam.id}`, () => {
      it("pins listRead/understand/write/maxBytes and the extension set", () => {
        const actual = FILE_CAPABILITY_FAMILIES.find((f) => f.id === fam.id);
        expect(actual).toBeDefined();
        expect(actual?.listRead).toBe(fam.listRead);
        expect(actual?.understand).toBe(fam.understand);
        expect(actual?.write).toBe(fam.write);
        expect(actual?.maxBytes).toBe(fam.maxBytes);
        // Exact extension list (kills any dropped/renamed extension literal).
        expect(actual?.extensions).toEqual([...fam.extensions]);
      });

      // Every individual extension must resolve to THIS family (kills each
      // extension StringLiteral and the `.includes` lookup branch).
      for (const ext of fam.extensions) {
        it(`resolves ${ext} -> ${fam.id} with the full capability shape`, () => {
          const cap = getCapabilityForExtension(ext);
          expect(cap?.id, ext).toBe(fam.id);
          expect(cap?.understand, ext).toBe(fam.understand);
          expect(cap?.write, ext).toBe(fam.write);
          expect(cap?.maxBytes, ext).toBe(fam.maxBytes);
        });
      }
    });
  }
});

describe("file-capability registry — FileCapabilityFamilyIdSchema vocabulary", () => {
  // FileCapabilityFamilyIdSchema is re-used by SkillPackSchema.capabilitySuiteIds
  // (skill-pack.ts), so its enum members are a runtime accept/reject contract:
  // dropping a member would make a valid skill-pack capability id reject. Each
  // member is pinned as an accepted value (kills the per-member StringLiteral and
  // the `z.enum([])` array-empty mutant, which would reject everything).
  it.each([
    "text",
    "office-document",
    "pdf",
    "rtf",
    "apple-iwork",
    "google-stub",
    "image",
    "audio",
    "video",
  ])("accepts the family id %s", (id) => {
    expect(FileCapabilityFamilyIdSchema.safeParse(id).success).toBe(true);
  });

  it("rejects an empty string and an unknown family id", () => {
    expect(FileCapabilityFamilyIdSchema.safeParse("").success).toBe(false);
    expect(FileCapabilityFamilyIdSchema.safeParse("nonsense").success).toBe(
      false,
    );
  });
});

describe("file-capability registry — CapabilityStatusSchema vocabulary", () => {
  // CapabilityStatusSchema is an exported runtime Zod enum that encodes the
  // closed vocabulary of per-family list/understand/write statuses. It is part
  // of the package's public surface, so its runtime accept/reject behaviour is a
  // contract: emptying the enum (z.enum([]) -> rejects everything) or blanking a
  // member literal ("supported" -> "") would make a valid status reject. Every
  // member is pinned as an accepted value so each per-member StringLiteral and
  // the array-empty mutant is observably killed at runtime, not just at the type
  // level.
  it.each([
    "supported",
    "unsupported",
    "plain-text",
    "extracted-text",
    "preview-or-export",
    "requires-google-export",
    "metadata-only",
    "ocr",
    "transcript",
    "native-text",
    "derived-output",
    "bounded-transform",
  ])("accepts the capability status %s", (status) => {
    expect(CapabilityStatusSchema.safeParse(status).success).toBe(true);
  });

  it("rejects an empty string and an unknown capability status", () => {
    expect(CapabilityStatusSchema.safeParse("").success).toBe(false);
    expect(CapabilityStatusSchema.safeParse("nonsense").success).toBe(false);
  });

  it("every family's declared statuses are themselves valid CapabilityStatus values", () => {
    for (const fam of FILE_CAPABILITY_FAMILIES) {
      expect(CapabilityStatusSchema.safeParse(fam.listRead).success).toBe(true);
      expect(CapabilityStatusSchema.safeParse(fam.understand).success).toBe(
        true,
      );
      expect(CapabilityStatusSchema.safeParse(fam.write).success).toBe(true);
    }
  });
});

describe("file-capability registry — lookup behaviour", () => {
  it("normalises the extension to lower-case before matching", () => {
    expect(getCapabilityForExtension(".PDF")?.id).toBe("pdf");
    expect(getCapabilityForExtension(".MP4")?.id).toBe("video");
  });

  it("returns null (not undefined) for an unknown extension", () => {
    expect(getCapabilityForExtension(".xyz")).toBeNull();
    expect(getCapabilityForExtension("")).toBeNull();
  });

  it("getReadableExtensions returns every extension across all families, flattened", () => {
    const expected = EXPECTED.flatMap((f) => [...f.extensions]);
    expect(getReadableExtensions()).toEqual(expected);
    // Length pin (kills a flatMap-to-map mutant that would nest arrays).
    expect(getReadableExtensions()).toHaveLength(expected.length);
  });
});
