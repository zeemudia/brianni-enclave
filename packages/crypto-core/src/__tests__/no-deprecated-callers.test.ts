/**
 * Auth-redesign Chunk 11 · Task 11.8b — CI-enforced regression.
 *
 * Closes Codex Chunk-3 round-5 finding: the atomic-replace migration
 * was documentary only; the deprecated `createVerificationBlob` /
 * `verifyRoot` / `wrapChatRoot` / `unwrapChatRoot` exports stayed
 * reachable from the package root throughout Chunks 3-10. This test
 * scans TypeScript import/export syntax (NOT plain symbol grep, which
 * false-positives on comments/docblocks) and fails the suite if any
 * future PR re-introduces them.
 *
 * Comments / docblocks / markdown that mention the deprecated names
 * for HISTORICAL/MIGRATION reasons (e.g. `verification-blob.ts`'s
 * docblock pointing at this very test) are intentionally exempt
 * because the regex matches `import|export ... from '...'` only.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// `process.cwd()` is the repo root when vitest runs at the workspace
// level; in workspace-package vitest runs it's the package root.
// Resolve the repo root by walking up to the directory that holds the
// `packages` folder.
function findRepoRoot(): string {
  let dir = path.resolve(__dirname);
  for (let i = 0; i < 10; i++) {
    try {
      readdirSync(path.join(dir, "packages"));
      return dir;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return process.cwd();
}

const ROOT = findRepoRoot();

// Match `envelope` / `argon2` / `argon2-params` ONLY as a complete
// final path segment — not as a substring of another segment like
// `crypto-envelope` (which is a legitimate, unrelated module).
const DEPRECATED_MODULE_SPECIFIER_RE =
  /^\s*(import|export)\s.*from\s+['"](@calypso\/crypto-core\/(envelope|argon2|argon2-params)|(?:\.{1,2}\/(?:[^'"]+\/)?)(?:envelope|argon2|argon2-params))(\.js)?['"]/m;

const DEPRECATED_BINDING_RE =
  /^\s*(import|export)\s*\{[^}]*\b(createVerificationBlob|verifyRoot|wrapChatRoot|unwrapChatRoot)\b[^}]*\}\s*from\s+['"][^'"]+['"]/m;

function stripAllowedMemoryEnvelopeImports(source: string): string {
  return source.replace(
    /^\s*(import|export)\s.*from\s+['"][^'"]*\/memory\/envelope(\.js)?['"];?\s*$/gm,
    "",
  );
}

function hasDeprecatedImportOrExport(source: string): boolean {
  const scanSource = stripAllowedMemoryEnvelopeImports(source);
  return (
    DEPRECATED_MODULE_SPECIFIER_RE.test(scanSource) ||
    DEPRECATED_BINDING_RE.test(scanSource)
  );
}

function collectTypeScriptFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === ".turbo" ||
        entry.name === ".next" ||
        entry.name === ".expo" ||
        entry.name === ".archive" ||
        entry.name.startsWith(".worktrees")
      ) {
        return [];
      }
      return collectTypeScriptFiles(fullPath);
    }
    return /\.(ts|tsx|mts|cts)$/.test(entry.name) ? [fullPath] : [];
  });
}

const SELF_PATH = path.join(
  "packages",
  "crypto-core",
  "src",
  "__tests__",
  "no-deprecated-callers.test.ts",
);

describe("no deprecated auth-redesign callers remain", () => {
  it("finds zero deprecated module imports/exports in packages/", () => {
    const offenders = collectTypeScriptFiles(path.join(ROOT, "packages"))
      .filter((filePath) => !filePath.endsWith(SELF_PATH))
      .flatMap((filePath) => {
        const source = readFileSync(filePath, "utf8");
        if (!hasDeprecatedImportOrExport(source)) {
          return [];
        }
        return [path.relative(ROOT, filePath)];
      });

    expect(
      offenders,
      `Expected zero deprecated import/export callers in packages/, found:\n${offenders.join(
        "\n",
      )}`,
    ).toEqual([]);
  });

  it("finds zero deprecated module imports/exports in apps/", () => {
    const offenders = collectTypeScriptFiles(path.join(ROOT, "apps")).flatMap(
      (filePath) => {
        const source = readFileSync(filePath, "utf8");
        if (!hasDeprecatedImportOrExport(source)) {
          return [];
        }
        return [path.relative(ROOT, filePath)];
      },
    );

    expect(
      offenders,
      `Expected zero deprecated import/export callers in apps/, found:\n${offenders.join(
        "\n",
      )}`,
    ).toEqual([]);
  });

  it("finds zero deprecated module imports/exports in server/", () => {
    const offenders = collectTypeScriptFiles(path.join(ROOT, "server")).flatMap(
      (filePath) => {
        const source = readFileSync(filePath, "utf8");
        if (!hasDeprecatedImportOrExport(source)) {
          return [];
        }
        return [path.relative(ROOT, filePath)];
      },
    );

    expect(
      offenders,
      `Expected zero deprecated import/export callers in server/, found:\n${offenders.join(
        "\n",
      )}`,
    ).toEqual([]);
  });
});
