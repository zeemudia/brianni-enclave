import { z } from "zod";

export const FileCapabilityFamilyIdSchema = z.enum([
  "text",
  "office-document",
  "pdf",
  "rtf",
  "apple-iwork",
  "google-stub",
  "image",
  "audio",
  "video",
]);

export const CapabilityStatusSchema = z.enum([
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
]);

export type FileCapabilityFamilyId = z.infer<
  typeof FileCapabilityFamilyIdSchema
>;
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;

export interface FileCapabilityFamily {
  readonly id: FileCapabilityFamilyId;
  readonly extensions: readonly string[];
  readonly listRead: CapabilityStatus;
  readonly understand: CapabilityStatus;
  readonly write: CapabilityStatus;
  readonly maxBytes: number;
}

export const FILE_CAPABILITY_FAMILIES = [
  {
    id: "text",
    extensions: [
      ".txt",
      ".md",
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".py",
      ".json",
      ".yaml",
      ".yml",
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
] as const satisfies readonly FileCapabilityFamily[];

export function getCapabilityForExtension(
  extension: string,
): FileCapabilityFamily | null {
  const normalised = extension.toLowerCase();
  return (
    FILE_CAPABILITY_FAMILIES.find((family) => {
      const extensions: readonly string[] = family.extensions;
      return extensions.includes(normalised);
    }) ?? null
  );
}

export function getReadableExtensions(): string[] {
  return FILE_CAPABILITY_FAMILIES.flatMap((family) => [...family.extensions]);
}
