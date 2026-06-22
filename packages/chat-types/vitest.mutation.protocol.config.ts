import { defineConfig } from 'vitest/config';

// Dedicated, hermetic Vitest config used ONLY by the chat-types-protocol Stryker
// mutation run (packages/chat-types/stryker.protocol.conf.json). chat-types has
// no committed vitest.config.ts, so `vitest run` would otherwise resolve the
// repo-root config (React-Native aliases + a whole-monorepo sweep). Pinning
// `root` to this package keeps the run scoped + fast.
//
// The mutation target is the IMPERATIVE residual protocol helpers that the
// padding.ts blocking target does NOT cover: the native web-search error
// classifier (native-web-search.ts), the file-capability extension lookup
// (file-capabilities.ts), and the Calypso follow-up message-history builder
// (calypso-follow-up.ts). Load only the suites that exercise them.
//
// `pool: 'forks'` is load-bearing: Stryker injects the active mutant via a global
// that a REUSED single Vitest worker can drop between mutants (observed as false
// survivors on masking-core / server-core mutation runs). A forked pool gives each
// run a clean worker so every mutant is actually exercised. `environment: 'node'`
// because these files are pure (no DOM / React-Native runtime needed).
export default defineConfig({
  root: __dirname,
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    include: [
      'src/__tests__/native-web-search.test.ts',
      'src/__tests__/native-web-search-classifier.mutation.test.ts',
      'src/__tests__/file-capabilities.test.ts',
      'src/__tests__/file-capabilities.mutation.test.ts',
      'src/__tests__/calypso-follow-up.test.ts',
      'src/__tests__/calypso-follow-up.mutation.test.ts',
    ],
  },
});
