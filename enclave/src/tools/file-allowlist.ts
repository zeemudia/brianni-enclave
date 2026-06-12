import {
  FILE_CAPABILITY_FAMILIES,
  type FileCapabilityFamilyId,
  getCapabilityForExtension,
  getReadableExtensions,
} from "@calypso/chat-types";

import { validateDocxContainer, zipHasMember } from "./ooxml-validator";

/**
 * Per-file MVP cap. Spec §7.1 names 5 MB; chunked tool-result transport
 * (multi-frame reassembly inside the enclave) lifts the single-frame
 * 200 KB wire ceiling so this can now match the spec verbatim.
 *
 * The wire layer is still capped at MAX_TOOL_RESULT_PLAINTEXT_BYTES per
 * FRAME — `tool-result-reassembler.ts` glues frames back together up
 * to MAX_REASSEMBLED_TOOL_RESULT_BYTES.
 *
 * **Deploy ordering / rollback notes.** Two directions to consider:
 *
 *   1. Stale CLIENT, new ENCLAVE (the natural deploy gap during a
 *      blue-green rollout): a pre-chunked-transport client trying to
 *      send a single-frame TOOL_RESULT for a >~280 KB file hits the
 *      server's `MAX_AGENT_TOOL_RESULT_BYTES` (512 KB) HTTP body
 *      limit and gets a 400. Clean visible error, NOT silent
 *      corruption. (Files under ~280 KB still fit single-frame and
 *      work unchanged.)
 *
 *   2. New CLIENT, stale ENCLAVE (a partial rollback): a chunked
 *      `_chunk`-tagged plaintext arriving at a pre-this-PR enclave
 *      would JSON.parse, dispatch into the standard resolver path
 *      without an `outcome` field, and resolve as
 *      `outcome: undefined` — the agent loop's ToolResultFrame
 *      validator (z.enum on outcome) would reject it as a malformed
 *      frame. The client surfaces this as TOOL_RESULT_HTTP_400. Also
 *      a clean failure surface, not silent corruption.
 *
 * On-the-wire capability negotiation was considered and rejected:
 * both failure modes are observable, the client-side chunking is
 * purely additive (single-frame payloads under CHUNK_SLICE_BYTES
 * still take the legacy path), and Calypso's blue-green flow is the
 * controlled deploy surface — a rollback that strands a small
 * fraction of users on an unsupported large-file path is acceptable
 * given the failure mode.
 */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Maximum aggregate plaintext bytes the gateway will relay back from
 * folder.read / file.read in a SINGLE TOOL_RESULT frame.
 *
 * **Wire-budget arithmetic** — Codex R4 finding #3 caught that R2's
 * 320 KB cap was still wrong. The full pipeline applies base64 TWICE
 * (once inside resultJson, once when the encrypted body is wrapped in
 * the HTTP/vsock `ciphertext` JSON field):
 *
 *   1. Plaintext aggregate file bytes P
 *   2. contentB64 inside resultJson: P × 4/3
 *   3. resultJson plaintext ≈ Σ(per-file JSON envelope ~250B) + 12B
 *      outer + Σ contentB64 = ~5 KB + P × 4/3 (for 20 files)
 *   4. AES-GCM encrypt → +28 bytes (IV + tag)
 *   5. Base64 the encrypted bytes → × 4/3 again
 *   6. JSON-wrap inside `{"session_id":..., "agent_turn_id":...,
 *      "ciphertext": "<b64>"}` → +~200 bytes envelope
 *   7. Total vsock JSON envelope ≤ MAX_VSOCK_PAYLOAD (512 KB)
 *
 *   Solving: 200 + (5040 + P × 4/3) × 4/3 ≤ 524,288
 *     ⇒ P × 4/3 ≤ 388,026
 *     ⇒ P ≤ ~284 KB
 *
 *   Round down to 200 KB for safety margin (filename length variance,
 *   base64 padding rounding, per-file JSON envelope variance, future
 *   small additions to the frame format).
 *
 *   See enclave/src/__tests__/tier-a-read.test.ts for the explicit
 *   arithmetic self-check that walks this whole stack.
 */
export const MAX_TOOL_RESULT_PLAINTEXT_BYTES = 200 * 1024;

/**
 * Maximum REASSEMBLED plaintext bytes the enclave will accept across
 * all chunks of one TOOL_RESULT invocation.
 *
 * **Sizing — accounts for base64 expansion of file content.** The
 * reassembled bytes are the raw single-frame inner JSON, which carries
 * `contentB64` = base64(file bytes). Base64 expands by 4/3, so a
 * MAX_FILE_BYTES (5 MiB) file becomes a ~6.99 MiB contentB64 string.
 * Add per-file JSON envelope (~250 B × MAX_TOOL_RESULT_FILES = 5 KiB)
 * + outer wrapper (~50 B) + ~1 MiB headroom for the {invocationId,
 * agentTurnId, outcome, reason} fields → cap at 8 MiB.
 *
 *   Worst case: 5 MiB × 4/3 + 5 KiB + 50 B ≈ 7.0 MiB ⇒ 8 MiB gives
 *   ~1 MiB cushion.
 *
 * Hard rejection above this bound — see `tool-result-reassembler.ts`.
 */
export const MAX_REASSEMBLED_TOOL_RESULT_BYTES = 8 * 1024 * 1024;

/**
 * Maximum number of chunks per invocation. Derived from
 * `ceil(MAX_REASSEMBLED_TOOL_RESULT_BYTES / MAX_TOOL_RESULT_PLAINTEXT_BYTES)`
 * plus a small margin for per-chunk JSON wrapper overhead (~200 B per
 * chunk × 40 chunks ≈ 8 KiB, negligible vs the 8 MiB cap). Any chunk
 * with a declared `total > MAX_TOOL_RESULT_CHUNKS` is rejected.
 *
 *   8 MiB / 200 KiB = 40.96 ⇒ 40 chunks covers a base64-expanded
 *   5 MiB file plus envelope.
 */
export const MAX_TOOL_RESULT_CHUNKS = 40;

/**
 * Maximum number of files folder.read may return in one TOOL_RESULT
 * frame. The agent must call file.read per filename for additional
 * files beyond this cap.
 */
export const MAX_TOOL_RESULT_FILES = 20;

/**
 * Maximum aggregate plaintext bytes the gateway will route from a
 * SINGLE Tier-A tool invocation into the agent's model context.
 *
 * **Why separate from MAX_REASSEMBLED_TOOL_RESULT_BYTES.**
 * MAX_REASSEMBLED governs how much the wire can carry (8 MiB to
 * accommodate base64-expanded 5 MiB files). The agent's model-
 * context budget is a different concern — a folder.read that packs
 * 4 × 1.5 MiB files into a 6 MiB resultJson would technically fit
 * the wire but would consume the model's entire context window in
 * one tool result. Cap the gateway-side aggregate at MAX_FILE_BYTES
 * (5 MiB) so a single max-sized file still fits while a folder of
 * mid-sized files cannot exhaust the context. The agent can issue
 * separate tool invocations for additional files.
 */
export const MAX_TOOL_AGGREGATE_PLAINTEXT_BYTES = MAX_FILE_BYTES;

export const TEXT_EXTENSIONS = new Set<string>(
  FILE_CAPABILITY_FAMILIES.find((family) => family.id === "text")?.extensions ??
    [],
);

const GOOGLE_STUB_EXTENSIONS = new Set<string>(
  FILE_CAPABILITY_FAMILIES.find((family) => family.id === "google-stub")
    ?.extensions ?? [],
);

const READABLE_EXTENSIONS = new Set(getReadableExtensions());

/**
 * Binary extensions whose magic bytes uniquely identify the format.
 *
 * `.docx` is accepted with a TWO-LAYER check (Codex round-2 finding #5
 * follow-up): magic-byte (PK\x03\x04) → OOXML container validation
 * via `validateDocxContainer`. The container check parses the ZIP
 * central directory, confirms `[Content_Types].xml` +
 * `word/document.xml` + `_rels/.rels` are present, and inflates
 * `[Content_Types].xml` to verify the wordprocessingml.document.main
 * content type is declared. A renamed JAR / xlsx / arbitrary ZIP is
 * rejected at the container layer.
 */
export const BINARY_EXTENSIONS = new Set<string>(
  getReadableExtensions().filter(
    (extension) =>
      !TEXT_EXTENSIONS.has(extension) && !GOOGLE_STUB_EXTENSIONS.has(extension),
  ),
);

export type AllowlistResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "FILE_TYPE_NOT_ALLOWED"
        | "FILE_TOO_LARGE"
        | "FILE_CONTENT_MISMATCH";
    };

export interface FileValidationInput {
  filename: string;
  mimeType?: string;
  byteLength: number;
  firstBytes?: Uint8Array;
  /**
   * Full file bytes. Required for `.docx` (the OOXML container check
   * walks the entire ZIP central directory + inflates one member).
   * Optional for every other extension — the magic-byte / UTF-8
   * checks only need the first few bytes.
   */
  fullBytes?: Uint8Array;
  capabilitySuiteIds?: readonly FileCapabilityFamilyId[];
}

export function validateFileForGateway(
  input: FileValidationInput,
): AllowlistResult {
  const dot = input.filename.lastIndexOf(".");
  if (dot <= 0) {
    return { ok: false, reason: "FILE_TYPE_NOT_ALLOWED" };
  }
  const ext = input.filename.slice(dot).toLowerCase();
  const capability = getCapabilityForExtension(ext);
  if (!capability) {
    return { ok: false, reason: "FILE_TYPE_NOT_ALLOWED" };
  }
  if (!isCapabilityEnabled(capability.id, input.capabilitySuiteIds)) {
    return { ok: false, reason: "FILE_TYPE_NOT_ALLOWED" };
  }
  if (input.byteLength > Math.min(MAX_FILE_BYTES, capability.maxBytes)) {
    return { ok: false, reason: "FILE_TOO_LARGE" };
  }

  const isBinary = BINARY_EXTENSIONS.has(ext);
  const isText = TEXT_EXTENSIONS.has(ext);
  const isGoogleStub = GOOGLE_STUB_EXTENSIONS.has(ext);

  if (!isBinary && !isText && !isGoogleStub) {
    return { ok: false, reason: "FILE_TYPE_NOT_ALLOWED" };
  }

  if (isGoogleStub) {
    if (!input.fullBytes || input.fullBytes.length !== input.byteLength) {
      return { ok: false, reason: "FILE_CONTENT_MISMATCH" };
    }
    if (!matchesGoogleStubJson(ext, input.fullBytes)) {
      return { ok: false, reason: "FILE_CONTENT_MISMATCH" };
    }
  } else if (isBinary) {
    if (!input.firstBytes || input.firstBytes.length === 0) {
      return { ok: false, reason: "FILE_CONTENT_MISMATCH" };
    }
    if (!matchesBinaryMagic(ext, input.firstBytes)) {
      return { ok: false, reason: "FILE_CONTENT_MISMATCH" };
    }
    // OOXML container check (currently `.docx` only). Magic-byte
    // alone accepts any ZIP — the full container check parses the
    // central directory and confirms the required OOXML parts +
    // content-type declaration. Without the full bytes we cannot
    // make this determination, so fail closed.
    if (ext === ".docx") {
      if (!input.fullBytes || input.fullBytes.length === 0) {
        return { ok: false, reason: "FILE_CONTENT_MISMATCH" };
      }
      const containerResult = validateDocxContainer(input.fullBytes);
      if (!containerResult.ok) {
        return { ok: false, reason: "FILE_CONTENT_MISMATCH" };
      }
    }
    if (isIWorkExtension(ext)) {
      if (!input.fullBytes || input.fullBytes.length !== input.byteLength) {
        return { ok: false, reason: "FILE_CONTENT_MISMATCH" };
      }
      if (!matchesIWorkPackage(input.fullBytes)) {
        return { ok: false, reason: "FILE_CONTENT_MISMATCH" };
      }
    }
  } else if (input.firstBytes && input.firstBytes.length > 0) {
    if (!isLikelyUtf8(input.firstBytes)) {
      return { ok: false, reason: "FILE_CONTENT_MISMATCH" };
    }
  }

  return { ok: true };
}

export function isAllowedGatewayExtension(
  filename: string,
  capabilitySuiteIds?: readonly FileCapabilityFamilyId[],
): boolean {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return false;
  const ext = filename.slice(dot).toLowerCase();
  if (!READABLE_EXTENSIONS.has(ext)) return false;
  const capability = getCapabilityForExtension(ext);
  return capability
    ? isCapabilityEnabled(capability.id, capabilitySuiteIds)
    : false;
}

function isCapabilityEnabled(
  capabilityId: FileCapabilityFamilyId,
  capabilitySuiteIds?: readonly FileCapabilityFamilyId[],
): boolean {
  return (
    capabilitySuiteIds === undefined ||
    capabilitySuiteIds.includes(capabilityId)
  );
}

function matchesBinaryMagic(ext: string, head: Uint8Array): boolean {
  switch (ext) {
    case ".pdf":
      return startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
    case ".docx":
      // PK\x03\x04 — ZIP local file header. The OOXML container check
      // (validateDocxContainer) is the real gate; this prefix check
      // just rejects obviously-not-ZIP bytes before we walk a CD.
      return startsWith(head, [0x50, 0x4b, 0x03, 0x04]);
    case ".rtf":
      return startsWith(head, [0x7b, 0x5c, 0x72, 0x74, 0x66]); // {\rtf
    case ".pages":
    case ".numbers":
    case ".key":
      return startsWith(head, [0x50, 0x4b, 0x03, 0x04]);
    case ".png":
      return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case ".jpg":
    case ".jpeg":
      return startsWith(head, [0xff, 0xd8, 0xff]);
    case ".heic":
      // ISO BMFF: 4 size bytes + 'ftyp' + brand. Brand should be a heic/heix/heif/mif1 variant.
      if (head.length < 12) return false;
      if (
        head[4] !== 0x66 ||
        head[5] !== 0x74 ||
        head[6] !== 0x79 ||
        head[7] !== 0x70
      ) {
        return false;
      }
      return (
        bytesEqual(head.slice(8, 12), [0x68, 0x65, 0x69, 0x63]) ||
        bytesEqual(head.slice(8, 12), [0x68, 0x65, 0x69, 0x78]) ||
        bytesEqual(head.slice(8, 12), [0x6d, 0x69, 0x66, 0x31])
      );
    case ".mp3":
      return (
        startsWith(head, [0x49, 0x44, 0x33]) ||
        (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0)
      );
    case ".wav":
      return (
        head.length >= 12 &&
        startsWith(head, [0x52, 0x49, 0x46, 0x46]) &&
        bytesEqual(head.slice(8, 12), [0x57, 0x41, 0x56, 0x45])
      );
    case ".m4a":
      return hasIsoBmffBrand(head, ["M4A ", "M4B ", "isom", "mp42"]);
    case ".aac":
      return head.length >= 2 && head[0] === 0xff && (head[1] & 0xf0) === 0xf0;
    case ".flac":
      return startsWith(head, [0x66, 0x4c, 0x61, 0x43]); // fLaC
    case ".ogg":
      return startsWith(head, [0x4f, 0x67, 0x67, 0x53]); // OggS
    case ".mp4":
      return hasIsoBmffBrand(head, [
        "isom",
        "iso2",
        "mp41",
        "mp42",
        "avc1",
        "M4V ",
      ]);
    case ".mov":
      return hasIsoBmffBrand(head, ["qt  "]);
    case ".webm":
    case ".mkv":
      return startsWith(head, [0x1a, 0x45, 0xdf, 0xa3]);
    default:
      return false;
  }
}

function startsWith(head: Uint8Array, prefix: readonly number[]): boolean {
  if (head.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (head[i] !== prefix[i]) return false;
  }
  return true;
}

function bytesEqual(a: Uint8Array, b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function hasIsoBmffBrand(head: Uint8Array, brands: readonly string[]): boolean {
  if (head.length < 12) return false;
  if (
    head[4] !== 0x66 ||
    head[5] !== 0x74 ||
    head[6] !== 0x79 ||
    head[7] !== 0x70
  ) {
    return false;
  }
  const majorBrand = new TextDecoder("ascii").decode(head.slice(8, 12));
  return brands.includes(majorBrand);
}

function matchesGoogleStubJson(ext: string, bytes: Uint8Array): boolean {
  if (!isLikelyUtf8(bytes)) return false;
  try {
    const parsed = JSON.parse(
      new TextDecoder("utf-8").decode(bytes),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.url !== "string") return false;
    const url = new URL(record.url);
    if (url.protocol !== "https:" || url.hostname !== "docs.google.com") {
      return false;
    }
    if (!googleStubPathMatchesExtension(ext, url.pathname)) return false;
    const resourceId =
      firstNonEmptyString(record.doc_id, record.resource_id) ??
      extractGoogleResourceId(url);
    return resourceId !== null;
  } catch {
    return false;
  }
}

function isIWorkExtension(ext: string): boolean {
  return ext === ".pages" || ext === ".numbers" || ext === ".key";
}

function matchesIWorkPackage(bytes: Uint8Array): boolean {
  return (
    zipHasMember(bytes, "Index.zip") ||
    zipHasMember(bytes, "Index/Document.iwa") ||
    zipHasMember(bytes, "Index/CalculationEngine.iwa") ||
    zipHasMember(bytes, "Index/Presentation.iwa")
  );
}

function googleStubPathMatchesExtension(ext: string, pathname: string): boolean {
  if (ext === ".gdoc") return pathname.includes("/document/");
  if (ext === ".gsheet") return pathname.includes("/spreadsheets/");
  if (ext === ".gslides") return pathname.includes("/presentation/");
  return false;
}

function extractGoogleResourceId(url: URL): string | null {
  const openId = url.searchParams.get("id");
  if (openId && openId.trim().length > 0) return openId;
  const match = url.pathname.match(
    /\/(?:document|spreadsheets|presentation)\/d\/([^/]+)/,
  );
  return match?.[1] && match[1].trim().length > 0 ? match[1] : null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

function isLikelyUtf8(head: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head);
    return true;
  } catch {
    return false;
  }
}
