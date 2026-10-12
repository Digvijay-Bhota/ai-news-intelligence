import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Server components import the Workers runtime; tests mock it.
      'cloudflare:workers': fileURLToPath(new URL('./tests/stubs/cloudflare-workers.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.tsx'],
    exclude: ['node_modules/**/*'],
    // Registers jest-dom matchers and DOM cleanup (no Vitest globals here).
    setupFiles: ['./tests/setup.ts'],
    pool: 'threads',
  },
});
