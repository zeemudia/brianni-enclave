import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Dedicated, hermetic Vitest config used ONLY by Stryker mutation runs
// (enclave/stryker.enclave-agent-egress-files.conf.json). Sibling of
// vitest.mutation.enclave-agent-tools.config.ts — see that file for the
// rationale behind pinning `root` to the enclave package and using an
// EXPLICIT allow-list `include` instead of a `*.test.ts` glob.
//
// This target covers the agent web.fetch EGRESS-TAINT exfiltration guard
// (tools/egress-taint.ts) and the Tier-A file CONTENT-TYPE / size allowlist
// (tools/file-allowlist.ts) — both pure (no vsock / network / DB), so they run
// hermetically under a forked Vitest pool.
//
// `pool: 'forks'` is load-bearing: Stryker injects the active mutant via a global
// that a REUSED single Vitest worker can drop between mutants. `environment: 'node'`
// because every mutated file is pure (no DOM / RN runtime).
export default defineConfig({
  root: resolve(__dirname),
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    include: [
      // Pre-existing covering suites.
      'src/__tests__/egress-taint.test.ts',
      'src/__tests__/egress-taint-adversarial.test.ts',
      'src/__tests__/file-allowlist.test.ts',
      // Mutation-hardening suites added for this target.
      'src/tools/__tests__/egress-taint.mutation.test.ts',
      'src/tools/__tests__/file-allowlist.mutation.test.ts',
    ],
  },
});
