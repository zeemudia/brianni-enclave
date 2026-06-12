import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const enclaveRoot = resolve(here, "..", "..");

/**
 * Codex LOW F21 — test files under src/ must NOT be compiled into the
 * production enclave image. tsconfig.json includes all of src and is used by
 * typecheck (so tests stay type-checked), but the BUILD that feeds the Nitro
 * EIF must use a config that excludes tests, otherwise every test change
 * rotates PCR0 and test code bloats the measured attack surface.
 */
describe("enclave production build excludes test files (F21)", () => {
  it("ships a build-only tsconfig that excludes tests and __tests__", () => {
    const buildCfg = JSON.parse(
      readFileSync(join(enclaveRoot, "tsconfig.build.json"), "utf8"),
    ) as { exclude?: string[]; include?: string[] };
    expect(buildCfg.include).toContain("src");
    const exclude = buildCfg.exclude ?? [];
    expect(exclude.some((p) => p.includes("*.test.ts"))).toBe(true);
    expect(exclude.some((p) => p.includes("__tests__"))).toBe(true);
  });

  it("wires the production build script to the build-only tsconfig", () => {
    const pkg = JSON.parse(
      readFileSync(join(enclaveRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.build).toContain("tsconfig.build.json");
  });
});
