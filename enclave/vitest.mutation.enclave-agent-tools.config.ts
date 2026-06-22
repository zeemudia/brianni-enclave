import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Dedicated, hermetic Vitest config used ONLY by Stryker mutation runs
// (enclave/stryker.enclave-agent-tools.conf.json). The enclave has no committed
// vitest.config.ts — its suites run under the repo-root vitest.config.ts via the
// root `yarn test`. For this mutation target we pin `root` to the enclave package
// and an EXPLICIT allow-list `include` of ONLY the suites that exercise the
// mutated agent/tool guard surface.
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
// `environment: 'node'` because every mutated file is pure (no DOM / RN runtime).
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
      // Pre-existing covering suites.
      'src/__tests__/scope-check.test.ts',
      'src/__tests__/parse-tool-call.test.ts',
      'src/__tests__/bridge-result-sanitiser.test.ts',
      'src/__tests__/tool-output-sanitizer.test.ts',
      'src/__tests__/copy-on-write-policy.test.ts',
      'src/agent/__tests__/cross-pack-grant.test.ts',
      'src/tools/__tests__/folder-resolver.test.ts',
      // Mutation-hardening suites added for this target.
      'src/tools/__tests__/folder-path-validator.test.ts',
      'src/tools/__tests__/copy-on-write-policy.mutation.test.ts',
      'src/tools/__tests__/copy-on-write-policy.boundaries.test.ts',
      'src/tools/__tests__/bridge-result-sanitiser.mutation.test.ts',
      'src/tools/__tests__/folder-resolver.mutation.test.ts',
      'src/tools/__tests__/scope-check.mutation.test.ts',
      'src/agent/__tests__/parse-tool-call.mutation.test.ts',
      'src/agent/__tests__/tool-output-sanitizer.mutation.test.ts',
      'src/agent/__tests__/cross-pack-grant.mutation.test.ts',
    ],
  },
});
