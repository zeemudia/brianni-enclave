import { defineConfig } from 'vitest/config';

// Dedicated, hermetic Vitest config used ONLY by Stryker mutation runs
// (packages/chat-types/stryker.conf.json). chat-types has no committed
// vitest.config.ts, so `vitest run` would otherwise resolve the repo-root
// config (React-Native aliases + a whole-monorepo sweep). Pinning `root` to
// this package keeps the mutation run scoped to chat-types' own pure tests.
//
// The mutation target is the IMPERATIVE padded-SSE binary-frame codec
// (padding.ts) — not the declarative Zod schema bodies — so we load only the
// test file that exercises it. Not used by `yarn workspace @calypso/chat-types
// test`.
export default defineConfig({
  root: __dirname,
  test: {
    globals: true,
    include: ['src/__tests__/padding.test.ts'],
  },
});
