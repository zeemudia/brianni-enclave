import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, posix } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const enclaveSrc = join(here, "..", ".."); // enclave/src
const repoRoot = join(enclaveSrc, "..", "..");
const chatTypesSrc = join(repoRoot, "packages", "chat-types", "src");
const skillsDir = join(repoRoot, "packages", "chat-types", "skills");

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkTs(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function measuredFiles(): string[] {
  const ts = [
    ...walkTs(enclaveSrc),
    ...(existsSync(chatTypesSrc) ? walkTs(chatTypesSrc) : []),
  ];
  const packs = existsSync(skillsDir)
    ? readdirSync(skillsDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => join(skillsDir, f))
    : [];
  return [...ts, ...packs];
}

const STATIC_FORBIDDEN = [
  "google-calendar",
  "list_events",
  "get_event",
  "list_calendars",
  "suggest_time",
  "create_event",
  "update_event",
  "delete_event",
  "respond_to_event",
];

const ALLOWED_FAMILY = new Set([
  "connector.list",
  "connector.read",
  "connector.act",
]);

function forbiddenTokens(): string[] {
  const tokens = new Set(STATIC_FORBIDDEN);
  const catalogPath = join(enclaveSrc, "connectors", "connectors.json");
  if (existsSync(catalogPath)) {
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
      connectors?: Array<{ id?: string; operations?: Array<{ id?: string }> }>;
    };
    for (const c of catalog.connectors ?? []) {
      if (c.id) tokens.add(c.id);
      for (const op of c.operations ?? []) if (op.id) tokens.add(op.id);
    }
  }
  for (const f of ALLOWED_FAMILY) tokens.delete(f);
  return [...tokens];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("connectors-no-measured-coupling (rotation-free guarantee, C1)", () => {
  const tokens = forbiddenTokens();
  const files = measuredFiles();

  it("resolves a non-empty measured set incl. prompt.ts + skill-pack.ts (TOOL_SCHEMAS + TOOL_NAMES coverage)", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.endsWith("prompt.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("skill-pack.ts"))).toBe(true);
  });

  for (const file of files) {
    it(`measured file names no specific connector/operation: ${file}`, () => {
      const src = readFileSync(file, "utf8");
      for (const token of tokens) {
        const re = new RegExp(`(?<![\\w-])${escapeRegExp(token)}(?![\\w-])`);
        expect(re.test(src)).toBe(false);
      }
    });
  }

  it("derives tokens from connectors.json when present — no silent degradation (R4-4)", () => {
    const catalogPath = join(enclaveSrc, "connectors", "connectors.json");
    if (!existsSync(catalogPath)) return;
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    for (const c of catalog.connectors ?? []) {
      if (c.id && !ALLOWED_FAMILY.has(c.id)) expect(tokens).toContain(c.id);
      for (const op of c.operations ?? []) if (op.id) expect(tokens).toContain(op.id);
    }
  });

  it("no measured file imports a per-connector module under connectors/ — only registry (import-graph guard, R4-4)", () => {
    const importRe = /from\s+["'][^"']*\/connectors\/([^"']+)["']/g;
    const ALLOWED_CONNECTOR_MODULES = new Set(["registry"]);
    for (const file of files.filter((f) => f.endsWith(".ts"))) {
      const src = readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(src)) !== null) {
        const mod = m[1].replace(/\.(ts|js)$/, "");
        expect(ALLOWED_CONNECTOR_MODULES.has(mod)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AST / import-graph hardening (R3-2)
//
// The Phase-1 regex guard above (`importRe`) only matches `from "…/connectors/X"`
// *static* import specifiers. It is BLIND to every other way a measured module
// can pull the host-served catalog or a per-connector adapter into the measured
// image: side-effect imports (`import "…"` — no `from`), re-exports
// (`export * from "…"`), TS import-equals (`import x = require("…")`), dynamic
// `import("…")`, and `require("…")` calls. It is also blind to a forbidden id
// rebuilt at runtime from string fragments (`"list" + "_events"`).
//
// This block parses every measured `.ts` with the TypeScript compiler and walks
// the actual import graph, closing all of those forms. It COMPLEMENTS the regex
// guard (which we keep intact) — the AST walk is the strict superset.
//
// Two parts:
//   (a) IMPORT-GRAPH — the LOAD-BEARING structural guarantee. No measured file
//       may resolve an import/export/require INTO the host-served catalog or a
//       per-connector module. Matched by RESOLVED PATH (segment-aware), never by
//       token-substring, so benign specifiers (`events`, `node:readline`,
//       `lib/list-utils`, `createMachine`) never collide.
//   (b) STRING-RECONSTRUCTION — defense-in-depth, NOT load-bearing. A folded
//       string literal must not contain a WHOLE forbidden id. Residuals a static
//       folder cannot catch (`String.fromCharCode`, `atob`/base64) are out of
//       scope here and are made moot by (a): even a reconstructed id is inert
//       unless the measured code can *reach* the catalog, which (a) forbids.
// ---------------------------------------------------------------------------

// Absolute, posix-normalised path to the connectors directory + catalog.
const connectorsDirPosix = enclaveSrc
  .split(/[\\/]/)
  .concat("connectors")
  .join("/");
const catalogModulePosix = `${connectorsDirPosix}/connectors`; // .json stripped

// Allowlisted module basenames under connectors/: the signed-catalog loader
// (`registry`) + its reserved co-located type module (`registry-types`, which
// may not exist yet — it is pre-allowed so a future split of the loader's types
// into a sibling module does not trip this gate). Everything else under
// connectors/ is a per-connector adapter that must NOT be reachable from
// measured code.
const ALLOWED_CONNECTOR_BASENAMES = new Set(["registry", "registry-types"]);

/** Strip a single trailing .ts/.tsx/.js/.jsx/.json extension. */
function stripModuleExt(p: string): string {
  return p.replace(/\.(tsx?|jsx?|json)$/, "");
}

/**
 * Lazily load + flatten the `compilerOptions.paths` aliases declared by the
 * measured tsconfigs (and any tsconfig they `extends`). The repo has NO `paths`
 * today, so this is normally empty — but it MUST exist so that a future
 * tsconfig alias re-opening the bypass (`@enclave/connectors/*`) is followed by
 * the resolver, not silently treated as a bare/external specifier.
 *
 * Returns { baseDirPosix, paths } where `paths` maps each alias pattern to its
 * target patterns, both as declared, and `baseDirPosix` is the posix dir the
 * `baseUrl` (or the tsconfig location, per TS semantics) resolves against.
 */
interface AliasTable {
  baseDirPosix: string;
  paths: Record<string, string[]>;
}

function toPosix(p: string): string {
  return p.split(/[\\/]/).join("/");
}

function loadTsconfigChain(tsconfigPath: string): {
  baseUrl: string | undefined;
  paths: Record<string, string[]>;
} {
  // Walk `extends` from leaf → root, with the leaf winning on conflicts.
  const seen = new Set<string>();
  let baseUrl: string | undefined;
  const paths: Record<string, string[]> = {};
  // Collect [leaf, ...parents]; apply parents first then leaf so leaf wins.
  const chain: Array<{ dir: string; co: Record<string, unknown> }> = [];
  let current: string | undefined = tsconfigPath;
  while (current && existsSync(current) && !seen.has(current)) {
    seen.add(current);
    // Use the TypeScript compiler's own JSONC-tolerant reader (tsconfig files
    // legally allow `//` comments + trailing commas, which `JSON.parse` rejects).
    // Still fail LOUD on a genuinely malformed config — a security gate must
    // never silently skip a tsconfig it could not read.
    const parsed = ts.readConfigFile(current, ts.sys.readFile);
    if (parsed.error) {
      throw new Error(
        `tsconfig parse failed for ${current}: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n")}`,
      );
    }
    const raw = (parsed.config ?? {}) as {
      extends?: string;
      compilerOptions?: Record<string, unknown>;
    };
    chain.push({ dir: dirname(current), co: raw.compilerOptions ?? {} });
    current = raw.extends ? join(dirname(current), raw.extends) : undefined;
  }
  // Apply root → leaf so the leaf (chain[0]) overrides.
  for (const { dir, co } of [...chain].reverse()) {
    if (typeof co.baseUrl === "string") {
      baseUrl = toPosix(join(dir, co.baseUrl));
    }
    if (co.paths && typeof co.paths === "object") {
      for (const [k, v] of Object.entries(co.paths as Record<string, unknown>)) {
        if (Array.isArray(v)) paths[k] = v.filter((x): x is string => typeof x === "string");
      }
    }
    // baseUrl defaults to the dir of the tsconfig that declared `paths`
    // (TS resolves non-baseUrl `paths` relative to the config's own dir).
    if (co.paths && baseUrl === undefined) baseUrl = toPosix(dir);
  }
  return { baseUrl, paths };
}

function aliasTables(): AliasTable[] {
  const out: AliasTable[] = [];
  const enclaveTsconfig = join(enclaveSrc, "..", "tsconfig.json");
  const chatTypesTsconfig = join(chatTypesSrc, "..", "tsconfig.json");
  for (const cfg of [enclaveTsconfig, chatTypesTsconfig]) {
    if (!existsSync(cfg)) continue;
    const { baseUrl, paths } = loadTsconfigChain(cfg);
    if (Object.keys(paths).length === 0) continue;
    out.push({ baseDirPosix: baseUrl ?? toPosix(dirname(cfg)), paths });
  }
  return out;
}

const ALIAS_TABLES = aliasTables();

/**
 * Resolve a module specifier (relative OR ts-path-aliased) to a posix-normalised
 * in-repo path with its extension stripped. Returns `null` for a specifier that
 * is neither relative NOR an in-repo alias (a genuine external npm package — it
 * cannot reach the in-repo catalog, so it is safe to ignore).
 */
function resolveSpecifier(file: string, spec: string): string | null {
  // Strip a runtime query/hash suffix some bundlers allow (`x?raw`).
  const clean = spec.replace(/[?#].*$/, "");
  if (clean === "") return null;

  // (i) Relative specifier → resolve against the importing file's dir.
  if (clean.startsWith("./") || clean.startsWith("../") || clean === "." || clean === "..") {
    const filePosix = toPosix(file);
    const joined = posix.normalize(posix.join(posix.dirname(filePosix), clean));
    return stripModuleExt(joined);
  }

  // (ii) Absolute (rare in source, but be safe) → normalise as-is.
  if (clean.startsWith("/")) {
    return stripModuleExt(posix.normalize(clean));
  }

  // (iii) TS path-aliased specifier → expand via the measured tsconfigs' paths.
  for (const { baseDirPosix, paths } of ALIAS_TABLES) {
    for (const [pattern, targets] of Object.entries(paths)) {
      const starIdx = pattern.indexOf("*");
      if (starIdx === -1) {
        if (pattern !== clean) continue;
        const target = targets[0];
        if (!target) continue;
        return stripModuleExt(posix.normalize(posix.join(baseDirPosix, target)));
      }
      const prefix = pattern.slice(0, starIdx);
      const suffix = pattern.slice(starIdx + 1);
      if (!clean.startsWith(prefix) || !clean.endsWith(suffix)) continue;
      const captured = clean.slice(prefix.length, clean.length - suffix.length);
      const target = targets[0];
      if (!target) continue;
      const expanded = target.replace("*", captured);
      return stripModuleExt(posix.normalize(posix.join(baseDirPosix, expanded)));
    }
  }

  // Neither relative nor an in-repo alias → genuine external package.
  return null;
}

/**
 * True iff the specifier, resolved relative to `file`, lands on the host-served
 * catalog (`connectors/connectors.json`) OR a module under `enclave/src/connectors/`
 * whose basename is NOT allowlisted. Segment-aware: compares full path segments,
 * never a raw token-substring, so `events`, `node:readline`, `lib/list-utils`
 * never trip it.
 */
function isForbiddenConnectorImport(file: string, spec: string): boolean {
  const resolved = resolveSpecifier(file, spec);
  if (resolved === null) return false;

  // The catalog itself (post .json-strip → `…/connectors/connectors`).
  if (resolved === catalogModulePosix) return true;

  // Any module under the connectors dir.
  const prefix = `${connectorsDirPosix}/`;
  if (!resolved.startsWith(prefix)) return false;
  const rest = resolved.slice(prefix.length);
  // A flat module `…/connectors/<name>` is allowlisted only if `<name>` is a
  // registry module. Anything NESTED under connectors/ (e.g. an `adapters/`
  // subdir, a per-connector module) is by definition not allowlisted → forbidden.
  if (rest.includes("/")) return true;
  return !ALLOWED_CONNECTOR_BASENAMES.has(rest);
}

/**
 * Fold a `BinaryExpression` `+`-chain or a template literal whose head and every
 * span expression are string literals into a single string. Returns `null` if
 * any operand is non-literal (we cannot statically know its value).
 */
function foldStringExpr(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isParenthesizedExpression(node)) {
    return foldStringExpr(node.expression);
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = foldStringExpr(node.left);
    const right = foldStringExpr(node.right);
    if (left === null || right === null) return null;
    return left + right;
  }
  if (ts.isTemplateExpression(node)) {
    let acc = node.head.text;
    for (const span of node.templateSpans) {
      const piece = foldStringExpr(span.expression);
      if (piece === null) return null;
      acc += piece + span.literal.text;
    }
    return acc;
  }
  return null;
}

/** Collect every module-specifier expression from a parsed source file. */
function collectModuleSpecifiers(sf: ts.SourceFile): ts.Expression[] {
  const specs: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    // import … from "x" | import "x" (side-effect) | export … from "x"
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      specs.push(node.moduleSpecifier);
    }
    // import x = require("x")
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression
    ) {
      specs.push(node.moduleReference.expression);
    }
    // dynamic import("x")  AND  require("x")
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isIdentifier(node.expression) && node.expression.text === "require";
      if ((isDynamicImport || isRequire) && node.arguments.length >= 1) {
        specs.push(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
}

/** Collect every statically-foldable string value in a parsed source file. */
function collectFoldedStrings(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.PlusToken) ||
      ts.isTemplateExpression(node)
    ) {
      const folded = foldStringExpr(node as ts.Expression);
      if (folded !== null) out.push(folded);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function parse(file: string, src: string): ts.SourceFile {
  return ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

describe("AST/import-graph hardening (R3-2)", () => {
  const tokens = forbiddenTokens();
  const tsFiles = measuredFiles().filter((f) => f.endsWith(".ts"));

  it("parses a non-empty measured .ts set", () => {
    expect(tsFiles.length).toBeGreaterThan(0);
  });

  // (a) IMPORT-GRAPH — load-bearing structural guarantee.
  for (const file of tsFiles) {
    it(`import graph reaches no per-connector module under connectors/: ${file}`, () => {
      const sf = parse(file, readFileSync(file, "utf8"));
      const specs = collectModuleSpecifiers(sf);
      for (const specNode of specs) {
        const folded = ts.isStringLiteralLike(specNode)
          ? specNode.text
          : foldStringExpr(specNode as ts.Expression);
        // A non-literal dynamic specifier (`import(varName)`) cannot be
        // statically resolved; (b) + the runtime catalog gate cover it.
        if (folded === null) continue;
        expect(isForbiddenConnectorImport(file, folded)).toBe(false);
      }
    });
  }

  // (b) STRING-RECONSTRUCTION — defense-in-depth, best-effort.
  for (const file of tsFiles) {
    it(`no folded string literal reconstructs a forbidden connector id: ${file}`, () => {
      const sf = parse(file, readFileSync(file, "utf8"));
      for (const folded of collectFoldedStrings(sf)) {
        for (const token of tokens) {
          const re = new RegExp(`(?<![\\w-])${escapeRegExp(token)}(?![\\w-])`);
          expect(re.test(folded)).toBe(false);
        }
      }
    });
  }

  // (4b) Close the alias space structurally — no measured tsconfig may declare a
  // `paths` alias whose target resolves into enclave/src/connectors/ other than
  // the allowlisted registry. Catches a FUTURE tsconfig that re-opens the bypass
  // even if `resolveSpecifier` missed a novel alias syntax.
  it("measured tsconfigs declare no connectors-reaching path alias (alias-space closure, R3-2)", () => {
    const enclaveTsconfig = join(enclaveSrc, "..", "tsconfig.json");
    const chatTypesTsconfig = join(chatTypesSrc, "..", "tsconfig.json");
    for (const cfg of [enclaveTsconfig, chatTypesTsconfig]) {
      if (!existsSync(cfg)) continue;
      const { baseUrl, paths } = loadTsconfigChain(cfg);
      const baseDir = baseUrl ?? toPosix(dirname(cfg));
      for (const targets of Object.values(paths)) {
        for (const target of targets) {
          // Resolve the alias target (drop a trailing `/*`) to a posix path.
          const concrete = target.replace(/\/\*$/, "").replace(/\*/g, "");
          const resolved = stripModuleExt(
            posix.normalize(posix.join(baseDir, concrete)),
          );
          const reaches =
            resolved === connectorsDirPosix ||
            resolved.startsWith(`${connectorsDirPosix}/`) ||
            resolved === catalogModulePosix;
          if (!reaches) continue;
          // Reaches connectors/ — only the allowlisted registry leaf is OK.
          const rest = resolved.startsWith(`${connectorsDirPosix}/`)
            ? resolved.slice(connectorsDirPosix.length + 1)
            : "";
          const leaf = rest.split("/")[0];
          expect(ALLOWED_CONNECTOR_BASENAMES.has(leaf)).toBe(true);
        }
      }
    }
  });
});
