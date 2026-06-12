import { isBoundedFolderPathSegment } from "./folder-path-validator";

export type CanonicalPathResult =
  | { ok: true; path: string }
  | { ok: false };

export type CopyOnWriteResult =
  | {
      ok: true;
      requestedOutputPath: string;
      outputPath: string;
      pathAdjusted: boolean;
    }
  | {
      ok: false;
      reason:
        | "INVALID_SOURCE_PATH"
        | "INVALID_OUTPUT_PATH"
        | "NO_AVAILABLE_COPY_PATH";
    };

export interface CopyOnWriteInput {
  sourcePath?: string | null;
  requestedOutputPath: string;
  existingPaths: readonly string[];
}

export type ClientWrittenPathResult =
  | {
      ok: true;
      writtenPath: string;
      pathAdjusted: boolean;
    }
  | { ok: false };

export interface ClientWrittenPathInput {
  sourcePath?: string | null;
  requestedOutputPath: string;
  enclaveOutputPath: string;
  writtenPath: string;
}

export function resolveCopyOutputPath(
  input: CopyOnWriteInput,
): CopyOnWriteResult {
  const source =
    typeof input.sourcePath === "string" && input.sourcePath.length > 0
      ? canonicaliseFolderPath(input.sourcePath)
      : null;
  if (source && !source.ok) return { ok: false, reason: "INVALID_SOURCE_PATH" };

  const output = canonicaliseFolderPath(input.requestedOutputPath);
  if (!output.ok) return { ok: false, reason: "INVALID_OUTPUT_PATH" };

  const taken = new Set<string>();
  for (const existing of input.existingPaths) {
    const canonical = canonicaliseFolderPath(existing);
    if (canonical.ok) taken.add(canonical.path);
  }

  const sourcePath = source?.path ?? null;
  if (output.path !== sourcePath && !taken.has(output.path)) {
    return {
      ok: true,
      requestedOutputPath: output.path,
      outputPath: output.path,
      pathAdjusted: false,
    };
  }

  const sameAsSource = output.path === sourcePath;
  for (let i = 1; i <= 100; i += 1) {
    const candidate = sameAsSource
      ? withCopySuffix(output.path, i)
      : withNumericSuffix(output.path, i + 1);
    if (candidate !== sourcePath && !taken.has(candidate)) {
      return {
        ok: true,
        requestedOutputPath: output.path,
        outputPath: candidate,
        pathAdjusted: true,
      };
    }
  }

  return { ok: false, reason: "NO_AVAILABLE_COPY_PATH" };
}

export function resolveClientWrittenPath(
  input: ClientWrittenPathInput,
): ClientWrittenPathResult {
  const requested = canonicaliseFolderPath(input.requestedOutputPath);
  const enclave = canonicaliseFolderPath(input.enclaveOutputPath);
  const written = canonicaliseFolderPath(input.writtenPath);
  if (!requested.ok || !enclave.ok || !written.ok) return { ok: false };

  const source =
    typeof input.sourcePath === "string" && input.sourcePath.length > 0
      ? canonicaliseFolderPath(input.sourcePath)
      : null;
  if (source && !source.ok) return { ok: false };

  if (written.path === enclave.path) {
    return {
      ok: true,
      writtenPath: written.path,
      pathAdjusted: written.path !== requested.path,
    };
  }

  const sourcePath = source?.path ?? null;
  if (written.path === sourcePath) return { ok: false };
  if (
    isNumericCollisionSuffix(requested.path, written.path) ||
    (sourcePath === requested.path &&
      isCopyCollisionSuffix(requested.path, written.path)) ||
    isNumericCollisionSuffix(enclave.path, written.path)
  ) {
    return { ok: true, writtenPath: written.path, pathAdjusted: true };
  }

  return { ok: false };
}

export function canonicaliseFolderPath(path: string): CanonicalPathResult {
  if (
    path.startsWith("/") ||
    path.startsWith("\\\\") ||
    /^[A-Za-z]:/.test(path) ||
    path.includes("\\")
  ) {
    return { ok: false };
  }
  const segments = path.split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) => !isBoundedFolderPathSegment(segment))
  ) {
    return { ok: false };
  }
  const normalised = segments.join("/");
  if (normalised !== path) {
    return { ok: false };
  }
  return { ok: true, path: normalised };
}

function isNumericCollisionSuffix(basePath: string, candidatePath: string): boolean {
  const base = splitPathParts(basePath);
  const candidate = splitPathParts(candidatePath);
  if (base.dir !== candidate.dir || base.ext !== candidate.ext) return false;
  const match = candidate.stem.match(/^(.*) ([1-9][0-9]*)$/);
  if (!match) return false;
  const index = Number(match[2]);
  return index >= 2 && index <= 101 && match[1] === base.stem;
}

function isCopyCollisionSuffix(basePath: string, candidatePath: string): boolean {
  const base = splitPathParts(basePath);
  const candidate = splitPathParts(candidatePath);
  if (base.dir !== candidate.dir || base.ext !== candidate.ext) return false;
  if (candidate.stem === `${base.stem} copy`) return true;
  const match = candidate.stem.match(/^(.*) copy ([1-9][0-9]*)$/);
  if (!match) return false;
  const index = Number(match[2]);
  return index >= 2 && index <= 100 && match[1] === base.stem;
}

function withCopySuffix(path: string, index: number): string {
  return withBasenameSuffix(path, index === 1 ? " copy" : ` copy ${index}`);
}

function withNumericSuffix(path: string, index: number): string {
  return withBasenameSuffix(path, ` ${index}`);
}

function withBasenameSuffix(path: string, suffix: string): string {
  const { dir, stem, ext } = splitPathParts(path);
  return `${dir}${stem}${suffix}${ext}`;
}

function splitPathParts(path: string): { dir: string; stem: string; ext: string } {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? `${path.slice(0, slash)}/` : "";
  const basename = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) return { dir, stem: basename, ext: "" };
  return {
    dir,
    stem: basename.slice(0, dot),
    ext: basename.slice(dot),
  };
}
