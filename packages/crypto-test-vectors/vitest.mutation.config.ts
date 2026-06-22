import { defineConfig } from 'vitest/config';

// Dedicated, hermetic Vitest config used ONLY by Stryker mutation runs
// (packages/crypto-test-vectors/stryker.conf.json). Pinned to `pool: 'forks'`
// to avoid the Stryker 9.6.1 + Vitest 4.1.4 reused-worker activation bug that
// can mis-report killable mutants as survived under the default `threads` pool
// (see docs/quality/mutation-triage/packages-vectors-fetch-ui.md). The parity
// tests run each frozen vector back through the real crypto (HKDF / HMAC /
// analyseStyle), so they are pure and hermetic — process-per-pass isolation
// costs nothing.
export default defineConfig({
  root: __dirname,
  test: {
    globals: true,
    include: ['src/__tests__/**/*.test.ts'],
    pool: 'forks',
  },
});
