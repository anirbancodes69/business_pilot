import { defineConfig } from 'vitest/config';

// Tenant isolation suite (docs/security/tenant-isolation-tests.md). Needs a real PostgreSQL:
//   pnpm stack:up  (or: docker compose ... up -d --wait postgres), with the variables of .env set.
export default defineConfig({
  test: {
    include: ['test/isolation/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    globalSetup: ['test/isolation/global-setup.ts'],
  },
});
