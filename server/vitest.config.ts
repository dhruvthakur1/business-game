import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Test files share one database, so run them one at a time.
    fileParallelism: false,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://mercantile@localhost:5433/mercantile_test',
      TIME_SCALE: '1',
    },
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
