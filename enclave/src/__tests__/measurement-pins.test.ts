import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..");

const knownBadPcr0 = new Map([
  [
    "0b520013aaeef1b039f33e3a2229c338f94d2a35929e0291b10f058b36eb3ffed80be4e8bcf1858fd5ad87ffaa7860fb",
    "debug-mode booted, but production mode exited before binding vsock during the 2026-06-01 rotation",
  ],
]);

const extractAssignment = (file: string, name: string) => {
  const source = readFileSync(file, "utf8");
  const match = source.match(new RegExp(`${name}=([0-9a-f]{96})`));
  return match?.[1] ?? "";
};

const extractObjectPcr0 = (file: string) => {
  const source = readFileSync(file, "utf8");
  const match = source.match(/PCR0:\s*["']([0-9a-f]{96})["']/);
  return match?.[1] ?? "";
};

const extractPublishedPcrValues = (file: string, label: "PCR0" | "PCR1" | "PCR2") => {
  const source = readFileSync(file, "utf8");
  return Array.from(
    source.matchAll(new RegExp(`${label}:\\s*\`?([0-9a-f]{96})\`?`, "g")),
    (match) => match[1],
  );
};

describe("published enclave measurement pins", () => {
  it("keeps all committed pin surfaces aligned and avoids known-bad PCR0s", () => {
    const measurement = JSON.parse(
      readFileSync(join(root, "enclave", "measurement.json"), "utf8"),
    ) as { pcr0?: string; pcr1?: string; pcr2?: string };
    const pcr0 = measurement.pcr0 ?? "";
    const pcr1 = measurement.pcr1 ?? "";
    const pcr2 = measurement.pcr2 ?? "";

    expect(pcr0).toMatch(/^[0-9a-f]{96}$/);
    expect(pcr1).toMatch(/^[0-9a-f]{96}$/);
    expect(pcr2).toMatch(/^[0-9a-f]{96}$/);
    expect(knownBadPcr0.get(pcr0) ?? null).toBeNull();

    const productSurfaces: Record<string, string> = {};
    const mobilePin = join(root, "apps", "mobile", "lib", "tee", "measurement.ts");
    const webPin = join(root, "apps", "web", "lib", "tee", "measurement.ts");
    const serverExample = join(root, "server", ".env.example");
    if (existsSync(mobilePin)) productSurfaces.mobile = extractObjectPcr0(mobilePin);
    if (existsSync(webPin)) productSurfaces.web = extractObjectPcr0(webPin);
    if (existsSync(serverExample)) {
      productSurfaces.serverExample = extractAssignment(
        serverExample,
        "EXPECTED_ENCLAVE_MEASUREMENT",
      );
    }

    if (Object.keys(productSurfaces).length > 0) {
      for (const [name, value] of Object.entries(productSurfaces)) {
        expect(value, `${name} PCR0`).toBe(pcr0);
      }
      return;
    }

    const markdownFiles = [join(root, "README.md"), join(root, "enclave", "README.md")].filter(
      existsSync,
    );
    expect(markdownFiles.length, "standalone repo should publish PCR docs").toBeGreaterThan(0);
    for (const file of markdownFiles) {
      const expected = { PCR0: pcr0, PCR1: pcr1, PCR2: pcr2 };
      for (const label of ["PCR0", "PCR1", "PCR2"] as const) {
        const values = extractPublishedPcrValues(file, label);
        expect(values.length, `${file} should publish ${label}`).toBeGreaterThan(0);
        expect(new Set(values), `${file} should publish only the pinned ${label}`).toStrictEqual(
          new Set([expected[label]]),
        );
      }
    }
  });
});
