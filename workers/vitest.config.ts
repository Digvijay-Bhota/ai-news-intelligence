import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
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
