import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // The Phase 2 ledger and comparison-runner CLI tests need real fs (atomic
    // file creation, cross-process/restart simulation) that the Workers pool
    // below does not provide. They run separately via vitest.ledger.config.ts
    // (`npm run test:ledger`).
    exclude: [
      ...configDefaults.exclude,
      'tests/gemini-quality-eval-ledger.test.ts',
      'tests/gemini-quality-comparison-runner.test.ts',
    ],
    pool: '@cloudflare/vitest-pool-workers',
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          compatibilityDate: '2024-08-15',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          kvNamespaces: ['CACHE'],
        },
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/', 'tests/setup.ts'],
    },
  },
});
