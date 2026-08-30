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
    // Every worker holds its own PGlite instance, so the suite's memory use scales
    // with the number of them. Unbounded, that is a few hundred megabytes per core
    // and enough to push a developer machine into swap while the app is also
    // running. Four is plenty for a suite this size.
    maxWorkers: 4,
    minWorkers: 1,
    env: {
      // Real bcrypt, minimum work factor. The production cost is set in password.ts.
      BCRYPT_ROUNDS: '4',
    },
  },
});
