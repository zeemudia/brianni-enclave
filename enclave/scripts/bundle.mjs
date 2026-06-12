// Bundle the enclave entry point into a single ESM file.
//
// The workspace packages (@calypso/chat-types, crypto-core, masking-core,
// nitro-verify, vsock-native) ship raw TypeScript as their main field so
// Vitest + tsx can consume them directly. That works in dev but fails
// under plain node (the enclave runtime) — `Unknown file extension ".ts"`.
//
// Bundling sidesteps the whole workspace-resolution mess: everything that
// the enclave imports (including transitive workspace deps) ends up inline
// in dist/index.js. Only Node built-ins and real third-party npm deps
// stay external.
//
// Native modules (vsock-native) are left external — they're optional deps
// of the enclave, loaded via dynamic import() at runtime, and have their
// own .node binaries that can't be bundled.

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const enclavePkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));

// Keep real npm packages external (they come from node_modules at runtime).
// Workspace deps (everything under @calypso/*) get bundled inline.
const externalNpm = Object.keys({
  ...enclavePkg.dependencies,
  ...enclavePkg.devDependencies,
}).filter((name) => !name.startsWith('@calypso/'));

// vsock-native ships a .node binary — cannot be bundled. Keep external and
// available under node_modules at runtime.
externalNpm.push('@calypso/vsock-native');

await build({
  entryPoints: [resolve(ROOT, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: resolve(ROOT, 'dist/index.js'),
  sourcemap: true,
  external: externalNpm,
  // ESM interop for CJS npm deps
  banner: {
    js: [
      "import { createRequire as _createRequire } from 'node:module';",
      "const require = _createRequire(import.meta.url);",
    ].join('\n'),
  },
  logLevel: 'info',
});

console.log('bundled to dist/index.js');
