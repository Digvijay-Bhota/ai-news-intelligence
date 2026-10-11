import { defineConfig } from 'vitest/config';

// Separate config for the Phase 2 comparison-runner's ledger tests, which
// need REAL filesystem access (atomic file creation, cross-process/restart
// simulation) that the main vitest.config.ts's @cloudflare/vitest-pool-workers
// pool does not provide. Everything else continues to run under the Workers
// pool via `npm test`; only these files run here, via `npm run test:ledger`.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/gemini-quality-eval-ledger*.test.ts', 'tests/gemini-quality-comparison-runner*.test.ts'],
  },
});
