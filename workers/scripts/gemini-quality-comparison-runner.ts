#!/usr/bin/env -S npx vite-node
/**
 * Phase 2 — Gemini quality-comparison runner.
 *
 * Runs via `vite-node` (same reason as scripts/gemini-quality-eval.ts: real
 * fs access outside the Workers test runtime, no new dependency).
 *
 * This tool never calls the production model router (model-router.ts) or
 * the automatic escalation path (gemini-escalation.ts) — it calls the real,
 * unmodified generator functions (generateEventBriefFromGemini /
 * generateNarrativeDeltaFromGemini / generateClaimComparisonsFromGemini)
 * directly, exactly once per (case, model) pair, for a maximum of
 * MAX_EXPERIMENT_REQUESTS (24) requests total across the whole experiment.
 * That cap is enforced by a durable, cross-process-safe, file-based ledger
 * (see tests/gemini-quality-eval/ledger.ts) that survives process restarts
 * and never refunds a reservation. The ledger lives at a fixed user-level
 * path (defaultLedgerRoot(), ~/.local/state/ai-news-intelligence/
 * gemini-quality-eval) shared by every worktree/clone on this machine; no
 * CLI flag or environment variable relocates it. It cannot coordinate
 * across different machines.
 *
 * Dry-run is the default and makes zero network calls and requires no API
 * key. A live request requires --execute AND a non-empty
 * GEMINI_QUALITY_EVAL_API_KEY — the production GEMINI_API_KEY is never read
 * as a fallback.
 *
 * Run with: npx vite-node scripts/gemini-quality-comparison-runner.ts -- [--execute] [--experiment-id <id>]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import type { Env } from '../src/types';
import {
  generateEventBriefFromGemini,
  generateNarrativeDeltaFromGemini,
  generateClaimComparisonsFromGemini,
} from '../src/tasks/gemini';
import { GeminiOutputValidationError } from '../src/tasks/gemini-errors';
import { validateSavedOutput, type EvalCase, type EvalModel } from '../tests/gemini-quality-eval/harness';
import {
  MAX_EXPERIMENT_REQUESTS,
  buildExperimentPlan,
  buildRunLogRecord,
  limitFetchToSingleRequest,
  redactKnownSecrets,
  resolveExecutionApiKey,
  wrapFetchForCapture,
  type CapturedResponseMeta,
  type PlannedPair,
} from '../tests/gemini-quality-eval/runner';
import {
  defaultLedgerRoot,
  resolveLedgerRoots,
  ensureLedgerDirs,
  getPairState,
  reserveNext,
  writeOutputOnce,
  writeRunLogOnce,
  checkLedgerConsistency,
  UnknownPairError,
  type LedgerRoots,
} from '../tests/gemini-quality-eval/ledger';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_EVAL_ROOT = join(HERE, '..', 'tests', 'gemini-quality-eval');
const DEFAULT_EXPERIMENT_ID = 'lite-vs-36-flash-12case-comparison';

export class UsageError extends Error {}

const USAGE = `Phase 2 Gemini quality-comparison runner.

Dry-run (default) makes zero network calls and requires no API key. It only
shows the full planned (case, model) pairs and their current ledger state.

Usage:
  npx vite-node scripts/gemini-quality-comparison-runner.ts -- [options]

Options:
  --execute                 Perform real requests (requires GEMINI_QUALITY_EVAL_API_KEY).
  --experiment-id <id>      Ledger namespace (default: ${DEFAULT_EXPERIMENT_ID}).
                             Must match /^[A-Za-z0-9_-]+$/.
  --eval-root <dir>         Override the eval root directory (for testing only).
                             Changes where cases are read and outputs written;
                             never the request ledger or its 24-request budget.
  --help                    Show this message.

Request ledger (shared by all worktrees/clones on this machine; not configurable):
  ${defaultLedgerRoot()}

Exit codes: 0 success, 1 runtime/consistency error, 2 usage error.`;

export function loadCases(evalRoot: string): EvalCase[] {
  const casesDir = join(evalRoot, 'cases');
  const files = readdirSync(casesDir).filter((f) => f.endsWith('.json'));
  return files.map((f) => JSON.parse(readFileSync(join(casesDir, f), 'utf8')) as EvalCase);
}

function validateExperimentId(id: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new UsageError(`Invalid --experiment-id: ${JSON.stringify(id)} (must match /^[A-Za-z0-9_-]+$/)`);
  }
}

function printPlan(roots: LedgerRoots, plan: PlannedPair[]): void {
  console.log(`Experiment plan — ${plan.length} (case, model) pairs (hard cap: ${MAX_EXPERIMENT_REQUESTS}):`);
  for (const pair of plan) {
    const state = getPairState(roots, pair.case_id, pair.model);
    console.log(`  [${state.padEnd(13)}] ${pair.case_id} (${pair.task}) x ${pair.model}`);
  }
}

async function callGenerator(evalCase: EvalCase, model: EvalModel, apiKey: string): Promise<unknown> {
  const env = { GEMINI_API_KEY: apiKey } as Env;
  switch (evalCase.task) {
    case 'event_brief':
      return generateEventBriefFromGemini(env, evalCase.event, evalCase.articles, model);
    case 'narrative_delta': {
      const ctx = evalCase.narrative_delta_context;
      if (!ctx) throw new Error(`Case ${evalCase.id} is missing narrative_delta_context`);
      return generateNarrativeDeltaFromGemini(
        env,
        evalCase.event,
        ctx.previous_brief,
        ctx.previous_version,
        ctx.current_version,
        evalCase.articles,
        model
      );
    }
    case 'claim_comparison':
      return generateClaimComparisonsFromGemini(env, evalCase.event, evalCase.articles, model);
  }
}

function safeErrorMessage(err: unknown, secrets: readonly string[] = []): string {
  return redactKnownSecrets(err instanceof Error ? err.message : String(err), secrets);
}

export async function runExperiment(
  roots: LedgerRoots,
  experimentId: string,
  cases: EvalCase[],
  plan: PlannedPair[],
  apiKey: string
): Promise<void> {
  const casesById = new Map(cases.map((c) => [c.id, c]));
  const knownCaseIds = new Set(casesById.keys());
  const secrets = [apiKey];

  for (const pair of plan) {
    const state = getPairState(roots, pair.case_id, pair.model);
    if (state !== 'not_attempted') {
      console.log(`Skipping ${pair.case_id} x ${pair.model}: ledger state is '${state}' (no retry).`);
      continue;
    }

    const reservation = await reserveNext(roots, pair.case_id, pair.model, knownCaseIds);
    if (!reservation.ok) {
      if (reservation.reason === 'cap_reached') {
        console.error(`Hard cap reached (${reservation.count} reservations already made). Stopping.`);
        return;
      }
      console.log(`Skipping ${pair.case_id} x ${pair.model}: reserved by another process just now.`);
      continue;
    }

    const reservedAt = reservation.reservedAt;
    const evalCase = casesById.get(pair.case_id);
    if (!evalCase) throw new Error(`Internal error: planned case ${pair.case_id} not found among loaded cases`);

    console.log(`Attempting ${pair.case_id} x ${pair.model}...`);

    const originalFetch = global.fetch;
    let captured: CapturedResponseMeta | null = null;
    // One reservation permits exactly one request: a second fetch during
    // this attempt is rejected before it reaches the network.
    global.fetch = wrapFetchForCapture(limitFetchToSingleRequest(originalFetch), (meta) => {
      captured = meta;
    });

    let rawOutput: unknown;
    let validation: ReturnType<typeof validateSavedOutput> | null = null;
    let thrown: unknown;
    try {
      rawOutput = await callGenerator(evalCase, pair.model, apiKey);
      validation = validateSavedOutput(evalCase, rawOutput);
      if (!validation.valid) {
        thrown = new GeminiOutputValidationError(validation.errors[0] ?? 'Mechanical validation failed');
      }
    } catch (err) {
      thrown = err;
    } finally {
      global.fetch = originalFetch;
    }

    if (thrown === undefined) {
      const outWrite = await writeOutputOnce(roots, pair.case_id, pair.model, rawOutput);
      if (outWrite === 'already_exists') {
        console.error(
          `Inconsistent state: output already exists for ${pair.case_id} x ${pair.model} after a fresh ` +
            `reservation. Refusing to continue — investigate manually before re-running.`
        );
        return;
      }
      const record = buildRunLogRecord({
        experimentId,
        caseId: pair.case_id,
        task: pair.task,
        model: pair.model,
        reservedAt,
        responseMeta: captured,
        outcome: 'completed',
        validation,
      });
      const logWrite = await writeRunLogOnce(roots, pair.case_id, pair.model, record);
      if (logWrite === 'already_exists') {
        console.error(`Inconsistent state: run-log already exists for ${pair.case_id} x ${pair.model}. Stopping.`);
        return;
      }
      console.log(`  completed (mechanically valid output saved).`);
    } else {
      const record = buildRunLogRecord({
        experimentId,
        caseId: pair.case_id,
        task: pair.task,
        model: pair.model,
        reservedAt,
        responseMeta: captured,
        outcome: 'failed',
        error: thrown,
        validation,
        secrets,
      });
      const logWrite = await writeRunLogOnce(roots, pair.case_id, pair.model, record);
      if (logWrite === 'already_exists') {
        console.error(`Inconsistent state: run-log already exists for ${pair.case_id} x ${pair.model}. Stopping.`);
        return;
      }
      console.log(`  failed: ${safeErrorMessage(thrown, secrets)}`);
    }
  }
}

function printSummary(roots: LedgerRoots, plan: PlannedPair[]): void {
  const counts: Record<string, number> = { not_attempted: 0, ambiguous: 0, completed: 0, failed: 0 };
  for (const pair of plan) {
    const state = getPairState(roots, pair.case_id, pair.model);
    counts[state] = (counts[state] ?? 0) + 1;
  }
  console.log('');
  console.log(
    `Summary: ${plan.length} planned — ${counts.completed} completed, ${counts.failed} failed, ` +
      `${counts.ambiguous} ambiguous (reserved, no run-log — a prior interrupted attempt), ` +
      `${counts.not_attempted} not attempted.`
  );
}

/**
 * `ledgerRoot` exists only so tests can point at a temporary ledger. The CLI
 * entry point below never passes it, and no flag or environment variable
 * maps to it, so a real run always uses the shared user-level ledger.
 */
export async function main(argv: string[], ledgerRoot: string = defaultLedgerRoot()): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      execute: { type: 'boolean', default: false },
      'experiment-id': { type: 'string', default: DEFAULT_EXPERIMENT_ID },
      'eval-root': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const experimentId = values['experiment-id'] as string;
  validateExperimentId(experimentId);
  const evalRoot = (values['eval-root'] as string) || DEFAULT_EVAL_ROOT;

  const cases = loadCases(evalRoot);
  const plan = buildExperimentPlan(cases); // throws if > 24 pairs — validated before any ledger access.

  // Dry-run is read-only: state checks below tolerate missing ledger
  // directories, which are only created once --execute is confirmed.
  const roots = resolveLedgerRoots(evalRoot, experimentId, ledgerRoot);

  const consistencyProblems = checkLedgerConsistency(
    roots,
    plan.map((p) => ({ caseId: p.case_id, model: p.model }))
  );
  if (consistencyProblems.length > 0) {
    console.error('Ledger consistency problems detected:');
    for (const p of consistencyProblems) {
      console.error(`  ${p.caseId} x ${p.model}: ${p.problem}`);
    }
    if (values.execute as boolean) {
      console.error('Refusing to execute with inconsistent ledger state. Investigate manually — nothing was reset.');
      return 1;
    }
    console.error('(dry-run: showing the plan below anyway; fix this before running --execute)');
  }

  printPlan(roots, plan);

  if (!(values.execute as boolean)) {
    console.log('');
    console.log('DRY RUN — no network calls were made, no reservations were consumed, no API key was read.');
    console.log('Pass --execute (with GEMINI_QUALITY_EVAL_API_KEY set) to actually run requests.');
    return consistencyProblems.length > 0 ? 1 : 0;
  }

  const keyResolution = resolveExecutionApiKey(process.env);
  if (!keyResolution.ok) {
    throw new UsageError(keyResolution.error);
  }

  ensureLedgerDirs(roots);
  await runExperiment(roots, experimentId, cases, plan, keyResolution.key);
  printSummary(roots, plan);
  return 0;
}

// Only auto-run when executed directly (via vite-node), never when imported
// by a test — this lets the orchestration above be exercised with mocked
// fetch and temporary ledger directories. An argv-based entry-point check
// cannot work here: vite-node rewrites process.argv so argv[1] is the
// vite-node binary, not this file. Vitest sets VITEST in every test worker.
const isDirectRun = process.env.VITEST === undefined;

if (isDirectRun) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError || err instanceof UnknownPairError) {
      console.error(`Error: ${safeErrorMessage(err)}\n\n${USAGE}`);
      process.exitCode = 2;
    } else {
      console.error('Unexpected error:', safeErrorMessage(err));
      process.exitCode = 1;
    }
  }
}
