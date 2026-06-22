import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Dedicated, hermetic Vitest config used ONLY by Stryker mutation runs
// (enclave/stryker.enclave-provider-media-dream.conf.json). The enclave has no
// committed vitest.config.ts — its suites run under the repo-root vitest.config.ts
// via the root `yarn test`. For the mutation target we pin `root` to the enclave
// package and an EXPLICIT allow-list `include` of ONLY the suites that exercise
// the mutated provider-routing / media-provenance / dream-routing surface.
//
// The include is an allow-list (not a `*.test.ts` glob) ON PURPOSE: enclave/src
// has 100+ suites, most of which neither cover the mutated files nor run cleanly
// under Stryker's per-package sandbox. Listing only the covering suites keeps the
// run hermetic, fast, and sandbox-safe.
//
// `pool: 'forks'` is load-bearing: Stryker injects the active mutant via a global
// that a REUSED single Vitest worker can drop between mutants (observed as false
// survivors on masking-core / server-core / connectors-core mutation runs). A
// forked pool gives each run a clean worker so every mutant is actually exercised.
// `environment: 'node'` because these files are pure (no DOM / RN runtime needed).
//
// Not used by the enclave's own `yarn workspace @calypso/enclave test`.
export default defineConfig({
  root: resolve(__dirname),
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    // Exactly the suites that cover the mutated files in the stryker conf's
    // `mutate` list. Keep in sync when adding a mutated file.
    include: [
      'src/__tests__/orchestrator-router.test.ts',
      'src/__tests__/orchestrator-video-routing.test.ts',
      'src/__tests__/media-provenance.test.ts',
      'src/__tests__/dream-model-routing.test.ts',
    ],
  },
});
