export type GoogleFileKind = "document" | "spreadsheet" | "presentation";

export interface GoogleStubMetadata {
  [key: string]: string;
  googleFileKind: GoogleFileKind;
  resourceId: string;
  url: string;
}

export function parseGoogleStub(
  filename: string,
  bytes: Uint8Array,
): GoogleStubMetadata {
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed = JSON.parse(raw) as {
    url?: unknown;
    doc_id?: unknown;
    resource_id?: unknown;
  };
  const url = typeof parsed.url === "string" ? parsed.url : "";
  const explicitId =
    typeof parsed.doc_id === "string"
      ? parsed.doc_id
      : typeof parsed.resource_id === "string"
        ? parsed.resource_id
        : "";
  return {
    googleFileKind: kindFromExtension(filename),
    resourceId: explicitId || extractResourceIdFromUrl(url),
    url,
  };
}

function kindFromExtension(filename: string): GoogleFileKind {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".gsheet")) return "spreadsheet";
  if (lower.endsWith(".gslides")) return "presentation";
  return "document";
}

function extractResourceIdFromUrl(value: string): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    const openId = url.searchParams.get("id");
    if (openId) return openId;
    const match = url.pathname.match(/\/(?:document|spreadsheets|presentation|file)\/d\/([^/]+)/);
    return match?.[1] ?? "";
  } catch {
    const match = value.match(/\/d\/([^/?#]+)/);
    return match?.[1] ?? "";
  }
}
