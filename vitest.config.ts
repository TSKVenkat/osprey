import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{apps,packages}/*/src/**/*.test.ts'],
    // The e2e specs are Playwright's, and need a running instance.
    exclude: ['**/node_modules/**', 'e2e/**'],
    environment: 'node',
    // Each API test starts an in-process Postgres and applies migrations, which is
    // slower than a unit test but still faster than waiting on a container.
    hookTimeout: 30_000,
    testTimeout: 30_000,
    env: {
      // Real bcrypt, minimum work factor. The production cost is set in password.ts.
      BCRYPT_ROUNDS: '4',
    },
  },
});
