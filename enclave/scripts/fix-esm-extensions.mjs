// Post-tsc pass: append runtime extensions to bare relative import specifiers.
//
// We compile with `moduleResolution: bundler` so source imports stay
// extension-less, which Vitest + tsx handle natively. Node's strict ESM
// loader does not, so for the enclave runtime we rewrite compiled JS:
//   import x from './foo'      -> import x from './foo.js'
//   import x from '../bar/baz' -> import x from '../bar/baz.js'
// Directory imports become `/index.js`.
//
// Docker build helpers may pass a different target extension for generated
// trees. Node built-ins, package names, and already-suffixed specifiers are
// left alone.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';

const rootArg = process.argv.find((arg, index) => index > 1 && !arg.startsWith('--'));
const targetExtArg = process.argv.find((arg) => arg.startsWith('--target-ext='));
const DIST = resolve(rootArg ?? 'dist');
const TARGET_EXT = targetExtArg?.split('=')[1] ?? '.js';

if (!/^\.[a-z0-9]+$/i.test(TARGET_EXT)) {
  throw new Error(`Invalid --target-ext value: ${TARGET_EXT}`);
}

const RELATIVE_IMPORT_RE =
  /(import\s+[^'"]*?from\s+|import\s+|export\s+[^'"]*?from\s+)(['"])(\.{1,2}\/[^'"]+?)\2/g;
const JSON_IMPORT_RE =
  /(import\s+[^'"]*?from\s+)(['"])(\.{1,2}\/[^'"]+?\.json)\2(?!\s+with\s*\{)/g;

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p)));
    else if (entry.name.endsWith(TARGET_EXT)) out.push(p);
  }
  return out;
}

function resolveSpecifier(importerFile, specifier) {
  if (/\.(mjs|cjs|js|json|ts)$/.test(specifier)) return specifier;
  const base = resolve(dirname(importerFile), specifier);
  if (existsSync(base + TARGET_EXT)) return specifier + TARGET_EXT;
  if (existsSync(join(base, `index${TARGET_EXT}`))) {
    return specifier.replace(/\/?$/, `/index${TARGET_EXT}`);
  }
  return specifier + TARGET_EXT;
}

const files = await walk(DIST);
let changed = 0;
for (const f of files) {
  const src = await readFile(f, 'utf8');
  const out = src.replace(RELATIVE_IMPORT_RE, (_, pre, q, spec) => {
    const resolved = resolveSpecifier(f, spec);
    return `${pre}${q}${resolved}${q}`;
  }).replace(JSON_IMPORT_RE, (_, pre, q, spec) => {
    return `${pre}${q}${spec}${q} with { type: "json" }`;
  });
  if (out !== src) {
    await writeFile(f, out);
    changed++;
  }
}
console.log(
  `fix-esm-extensions: rewrote ${changed} / ${files.length} ${TARGET_EXT} files under ${DIST}`,
);
