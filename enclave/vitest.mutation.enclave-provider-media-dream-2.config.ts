import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Dedicated, hermetic Vitest config used ONLY by Stryker mutation runs
// (enclave/stryker.enclave-provider-media-dream-2.conf.json). The enclave has no
// committed vitest.config.ts — its suites run under the repo-root vitest.config.ts
// via the root `yarn test`. For the mutation target we pin `root` to the enclave
// package and an EXPLICIT allow-list `include` of ONLY the suites that exercise
// the mutated provider-error / provider-health / media-accounting / dream
// extraction+reconciliation surface.
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
// This is the SECOND enclave provider/media/dream mutation slice — the first
// (vitest.mutation.enclave-provider-media-dream.config.ts) covers router.ts /
// provenance.ts / model-routing.ts. This slice covers the remaining
// behavior-bearing files: providers/errors.ts, orchestrator/provider-health.ts,
// media/budget.ts, media/custody-gate.ts, media/provider-visible-input.ts,
// dream/extract.ts, dream/reconcile.ts, dream/parse-json.ts.
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
      'src/__tests__/provider-errors.test.ts',
      'src/__tests__/provider-errors-mutation.test.ts',
      'src/__tests__/provider-errors-classify-message.test.ts',
      'src/__tests__/orchestrator-provider-health.test.ts',
      'src/__tests__/provider-health-mutation.test.ts',
      'src/__tests__/media-budget.test.ts',
      'src/__tests__/media-custody-gate.test.ts',
      'src/__tests__/media-provider-input.test.ts',
      'src/__tests__/media-provider-visible-input.test.ts',
      'src/__tests__/dream-extract.test.ts',
      'src/__tests__/dream-extract-mutation.test.ts',
      'src/__tests__/dream-reconcile.test.ts',
      'src/__tests__/dream-reconcile-mutation.test.ts',
      'src/__tests__/dream-media-mutation.test.ts',
      'src/__tests__/dream-parse-json.test.ts',
      'src/__tests__/dream-parse-json-mutation.test.ts',
    ],
  },
});
