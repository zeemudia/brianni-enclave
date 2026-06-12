// Prepare workspace packages for the Nitro runtime image.
//
// The repo keeps workspace package exports pointed at TypeScript source for
// local bundler-mode tooling. The enclave image runs plain Node, so it needs
// runtime JavaScript package entrypoints. This script builds the small subset
// of workspace package code the enclave imports, fixes strict ESM specifiers,
// and rewrites package.json inside the Docker build copy only.

import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const packagesDirArg = process.argv.find((arg) => arg.startsWith("--packages-dir="));
const packagesDir = resolve(packagesDirArg?.split("=")[1] ?? "packages");
const chatTypesDir = join(packagesDir, "chat-types");
const distRuntime = join(chatTypesDir, "dist-runtime");

const esbuild = resolve("node_modules/.bin/esbuild");
const node = process.execPath;

async function filesWithExt(dir, ext) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(ext))
    .map((entry) => join(dir, entry.name));
}

await mkdir(join(distRuntime, "skills"), { recursive: true });

const tsEntries = [
  ...(await filesWithExt(join(chatTypesDir, "src"), ".ts")),
  ...(await filesWithExt(join(chatTypesDir, "skills"), ".ts")),
];

execFileSync(
  esbuild,
  [
    ...tsEntries,
    "--format=esm",
    "--platform=node",
    "--target=node22",
    `--outdir=${distRuntime}`,
    `--outbase=${chatTypesDir}`,
    "--packages=external",
    "--log-level=info",
  ],
  { stdio: "inherit" },
);

for (const jsonFile of await filesWithExt(join(chatTypesDir, "skills"), ".json")) {
  await copyFile(jsonFile, join(distRuntime, "skills", jsonFile.split("/").pop()));
}

execFileSync(
  node,
  [
    "enclave/scripts/fix-esm-extensions.mjs",
    distRuntime,
    "--target-ext=.js",
  ],
  { stdio: "inherit" },
);

const packageJsonPath = join(chatTypesDir, "package.json");
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));

packageJson.main = "dist-runtime/src/index.js";
packageJson.exports = {
  ...packageJson.exports,
  ".": "./dist-runtime/src/index.js",
  "./skills": "./dist-runtime/skills/index.js",
  "./memory": "./dist-runtime/src/memory.js",
};

await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

console.log("prepare-runtime-workspaces: built @calypso/chat-types runtime JS");
