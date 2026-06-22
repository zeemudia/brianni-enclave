import { defineConfig } from 'vitest/config';

// Dedicated, hermetic Vitest config used ONLY by Stryker mutation runs
// (packages/vsock-native/stryker.conf.json). vsock-native has no committed
// vitest.config.ts, so `vitest run` would otherwise resolve the repo-root
// config (React-Native aliases + a whole-monorepo sweep). Pinning `root` to
// this package keeps the mutation run scoped to the JS wrapper's own tests.
//
// The native addon (src/vsock_addon.cc) is Linux-only and is NOT compiled on
// macOS/CI, so it cannot be mutated and is out of scope. The mutation target is
// the JS BOUNDARY wrapper (lib/index.js): the accept-error classifier
// (fatal / retry / retry-delayed), the addon-load diagnostics, and the
// VsockSocket stream lifecycle. Those tests stub the native addon via
// `_setAddonForTests`, so the suite is fully hermetic — no real AF_VSOCK fd is
// ever opened.
//
// `pool: 'forks'` is load-bearing: Stryker injects the active mutant via a
// global that a REUSED single Vitest worker can drop between mutants (observed
// as false survivors on masking-core / server-core / connectors-core mutation
// runs). A forked pool gives each run a clean worker so every mutant is
// actually exercised. `environment: 'node'` because the wrapper is pure Node
// (streams / events / fs), no DOM.
//
// Not used by `yarn workspace @calypso/vsock-native test`.
export default defineConfig({
  root: __dirname,
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    include: [
      'lib/__tests__/index.test.ts',
      'lib/__tests__/accept-loop.test.js',
      'lib/__tests__/boundary.test.js',
    ],
  },
});
