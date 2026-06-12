import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      'src/__tests__/search-hmac-parity.test.ts',
    ],
    globals: true,
  },
});
