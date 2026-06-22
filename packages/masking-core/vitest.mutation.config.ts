import { defineConfig } from 'vitest/config';

// Dedicated, hermetic Vitest config used ONLY by Stryker mutation runs
// (packages/masking-core/stryker.conf.json). It exists to pin `pool: 'forks'`.
//
// Why forks: Stryker's vitest-runner pins the test runner to a single reused
// worker on the `threads` pool. Under Stryker 9.6.1 + Vitest 4.1.4 that reused
// worker accumulates module/global state across the 1,200+ per-mutant runs, and
// for a small set of mutants the per-file `inject('activeMutant')` value no
// longer reflects the mutant currently under test — so the mutant is never
// actually flipped, its covering tests pass, and it is mis-reported as
// "Survived" even though those same tests kill it in isolation (proven by
// scripts/verify-mutation-survivors.mjs). The `forks` pool runs each test pass
// in a fresh child process, so active-mutant injection propagates reliably and
// the false survivors are correctly killed — with no extra RuntimeErrors (which
// `isolate: false` introduced) and no run-time penalty. See
// docs/quality/mutation-triage/masking-core.md for the full diagnosis.
//
// The masking-core unit tests are pure and hermetic, so process-per-pass
// isolation costs nothing here. Not used by `yarn test:packages`.
export default defineConfig({
  root: __dirname,
  test: {
    globals: true,
    include: ['src/**/__tests__/**/*.test.ts'],
    pool: 'forks',
  },
});
