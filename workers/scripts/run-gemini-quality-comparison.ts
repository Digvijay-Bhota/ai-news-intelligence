#!/usr/bin/env -S npx vite-node
/**
 * CLI entry point for the Phase 2 Gemini quality-comparison runner.
 *
 * This wrapper is the ONLY place that runs the runner and the only place
 * that selects the real, shared user-level request ledger. The
 * implementation (gemini-quality-comparison-runner.ts) has no import-time
 * side effects, so it can be imported without parsing arguments or
 * executing anything.
 *
 *   Dry-run (default, read-only):  npx vite-node scripts/run-gemini-quality-comparison.ts
 *   Offline reconciliation:        npx vite-node scripts/run-gemini-quality-comparison.ts -- --reconcile
 *   Live run (separately approved): npx vite-node scripts/run-gemini-quality-comparison.ts -- --execute
 */
import { defaultLedgerRoot } from '../tests/gemini-quality-eval/ledger';
import { runCli } from './gemini-quality-comparison-runner';

process.exitCode = await runCli(process.argv.slice(2), defaultLedgerRoot());
