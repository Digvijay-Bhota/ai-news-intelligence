/**
 * Phase 2 — Gemini quality-comparison runner (implementation).
 *
 * Importing this module has NO side effects: it never parses process.argv
 * and never runs anything. The executable entry point is the small wrapper
 * scripts/run-gemini-quality-comparison.ts, which is also the only place
 * that selects the real user-level ledger; main()/runCli() require an
 * explicit ledger root.
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
 * across different machines. Pairs are keyed globally by (case, model):
 * once reserved, a pair is never requested again from any checkout.
 *
 * Dry-run is the default: read-only, zero network calls; it neither requires
 * nor uses an API key.
 * --reconcile is offline: it completes interrupted-but-saved runs from their
 * verified canonical output and copies verified outputs into this
 * checkout's outputs/, without a key or any request. A live request requires
 * --execute AND a non-empty GEMINI_QUALITY_EVAL_API_KEY — the production
 * GEMINI_API_KEY is never read as a fallback.
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
import { GeminiOutputValidationError, classifyGeminiFailure } from '../src/tasks/gemini-errors';
import { validateSavedOutput, type EvalCase, type EvalModel } from '../tests/gemini-quality-eval/harness';
import {
  EXPERIMENT_ID,
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
  inspectLedgerLayout,
  reserveNext,
  writeCanonicalOutputOnce,
  writeRejectedOutputOnce,
  writeRunLogOnce,
  serializeOutput,
  UnknownPairError,
  type LedgerRoots,
} from '../tests/gemini-quality-eval/ledger';
import {
  findCorruptPairs,
  getPairState,
  loadVerifiedOutput,
  materializeLocalCopy,
  reconcileAndMaterialize,
} from '../tests/gemini-quality-eval/ledger-state';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_EVAL_ROOT = join(HERE, '..', 'tests', 'gemini-quality-eval');

export class UsageError extends Error {}

function usage(): string {
  return `Phase 2 Gemini quality-comparison runner.

Dry-run (default) is read-only, makes zero network calls and requires no API
key. It shows the planned (case, model) pairs and their ledger state.

Usage:
  npx vite-node scripts/run-gemini-quality-comparison.ts -- [options]

Options:
  --execute                 Perform real requests (requires GEMINI_QUALITY_EVAL_API_KEY).
                             Reconciles interrupted runs first; never re-sends a reserved pair.
  --reconcile               Offline only (no key, no requests): complete interrupted runs whose
                             verified output was saved, and copy verified outputs into outputs/.
  --eval-root <dir>         Override the eval root directory (for testing only).
                             Changes where cases are read and local copies written;
                             never the request ledger or its 24-request budget.
  --help                    Show this message.

Request ledger (shared by all worktrees/clones on this machine; not configurable):
  ${defaultLedgerRoot()}

Exit codes: 0 success, 1 runtime/consistency error, 2 usage error.`;
}

export function loadCases(evalRoot: string): EvalCase[] {
  const casesDir = join(evalRoot, 'cases');
  const files = readdirSync(casesDir).filter((f) => f.endsWith('.json'));
  return files.map((f) => JSON.parse(readFileSync(join(casesDir, f), 'utf8')) as EvalCase);
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

/**
 * Attempts every not-yet-reserved planned pair once. Returns false if it had
 * to stop on an inconsistent ledger state (the caller exits non-zero).
 */
export async function runExperiment(
  roots: LedgerRoots,
  cases: EvalCase[],
  plan: PlannedPair[],
  apiKey: string
): Promise<boolean> {
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
        return true;
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
    const modelText: { value: string | null } = { value: null };
    // One reservation permits exactly one request: a second fetch during
    // this attempt is rejected before it reaches the network.
    global.fetch = wrapFetchForCapture(limitFetchToSingleRequest(originalFetch), (meta, text) => {
      captured = meta;
      modelText.value = text;
    });

    let rawOutput: unknown;
    let validation: ReturnType<typeof validateSavedOutput> | null = null;
    let thrown: unknown;
    try {
      rawOutput = await callGenerator(evalCase, pair.model, apiKey);
      validation = validateSavedOutput(evalCase, rawOutput);
      if (!validation.valid) {
        thrown = new GeminiOutputValidationError(validation.errors[0] ?? 'Mechanical validation failed');
      } else if (serializeOutput(rawOutput).includes(apiKey)) {
        // Cannot happen with a sane model (the key is never in the prompt),
        // but an artifact containing the key must never be persisted.
        thrown = new Error('Model output contained the API key; output discarded');
      }
    } catch (err) {
      thrown = err;
    } finally {
      global.fetch = originalFetch;
    }

    // Output the model DID return but that failed validation (schema,
    // grounding, or unparseable JSON) is preserved as its raw text and
    // recorded as 'invalid' — never discarded, never retried.
    let rejectedText: string | null = null;
    if (thrown !== undefined && classifyGeminiFailure(thrown).classification === 'invalid_output' && modelText.value !== null) {
      if (modelText.value.includes(apiKey)) {
        thrown = new Error('Model output failed validation and contained the API key; not preserved');
      } else {
        rejectedText = modelText.value;
      }
    }

    if (thrown === undefined) {
      // Order: canonical output (durable) -> completing run-log with its
      // SHA-256 (durable, the commit point) -> local convenience copy.
      const canonical = await writeCanonicalOutputOnce(roots, pair.case_id, pair.model, rawOutput);
      if (canonical.result === 'already_exists') {
        console.error(
          `Inconsistent state: a canonical output already exists for ${pair.case_id} x ${pair.model} after a fresh ` +
            `reservation. Refusing to continue — investigate manually before re-running.`
        );
        return false;
      }
      const record = buildRunLogRecord({
        experimentId: EXPERIMENT_ID,
        caseId: pair.case_id,
        task: pair.task,
        model: pair.model,
        reservedAt,
        responseMeta: captured,
        outcome: 'completed',
        validation,
        secrets,
        outputSha256: canonical.sha256,
      });
      const logWrite = await writeRunLogOnce(roots, pair.case_id, pair.model, record);
      // 'already_exists' is only acceptable if a concurrent --reconcile
      // completed this same pair from the canonical output just written.
      if (logWrite === 'already_exists' && getPairState(roots, pair.case_id, pair.model) !== 'completed') {
        console.error(`Inconsistent state: run-log already exists for ${pair.case_id} x ${pair.model}. Stopping.`);
        return false;
      }
      const verified = loadVerifiedOutput(roots, pair.case_id, pair.model);
      if (!verified.ok) {
        console.error(`Saved output for ${pair.case_id} x ${pair.model} failed verification: ${verified.problem}. Stopping.`);
        return false;
      }
      const local = await materializeLocalCopy(roots, pair.case_id, pair.model, verified.bytes);
      console.log(
        `  completed (validated output saved to the ledger, sha256 ${canonical.sha256.slice(0, 12)}…` +
          `${local === 'local_differs' ? '; existing local copy differs and was left unchanged' : ''}).`
      );
    } else if (rejectedText !== null) {
      // Order: rejected output (durable) -> 'invalid' run-log with its SHA-256.
      const rejected = await writeRejectedOutputOnce(roots, pair.case_id, pair.model, rejectedText);
      if (rejected.result === 'already_exists') {
        console.error(`Inconsistent state: a rejected output already exists for ${pair.case_id} x ${pair.model}. Stopping.`);
        return false;
      }
      const message = safeErrorMessage(thrown, secrets);
      const record = buildRunLogRecord({
        experimentId: EXPERIMENT_ID,
        caseId: pair.case_id,
        task: pair.task,
        model: pair.model,
        reservedAt,
        responseMeta: captured,
        outcome: 'invalid',
        error: thrown,
        validation: validation ?? { valid: false, errors: [message] },
        secrets,
        outputSha256: rejected.sha256,
      });
      const logWrite = await writeRunLogOnce(roots, pair.case_id, pair.model, record);
      if (logWrite === 'already_exists' && getPairState(roots, pair.case_id, pair.model) !== 'invalid') {
        console.error(`Inconsistent state: run-log already exists for ${pair.case_id} x ${pair.model}. Stopping.`);
        return false;
      }
      console.log(`  invalid: ${message} (model output preserved for review, sha256 ${rejected.sha256.slice(0, 12)}…).`);
    } else {
      const record = buildRunLogRecord({
        experimentId: EXPERIMENT_ID,
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
        return false;
      }
      console.log(`  failed: ${safeErrorMessage(thrown, secrets)}`);
    }
  }
  return true;
}

function printSummary(roots: LedgerRoots, plan: PlannedPair[]): void {
  const counts: Record<string, number> = { not_attempted: 0, ambiguous: 0, incomplete: 0, completed: 0, invalid: 0, failed: 0, corrupt: 0 };
  for (const pair of plan) {
    const state = getPairState(roots, pair.case_id, pair.model);
    counts[state] = (counts[state] ?? 0) + 1;
  }
  console.log('');
  console.log(
    `Summary: ${plan.length} planned — ${counts.completed} completed, ` +
      `${counts.invalid} invalid (output failed validation; preserved for review), ${counts.failed} failed, ` +
      `${counts.ambiguous} ambiguous (reserved, no outcome — a prior interrupted attempt; never re-sent), ` +
      `${counts.incomplete} incomplete (saved, completion not recorded — run --reconcile), ` +
      `${counts.corrupt} corrupt, ${counts.not_attempted} not attempted.`
  );
}

function dedicatedKeySecrets(): string[] {
  const key = process.env.GEMINI_QUALITY_EVAL_API_KEY;
  return key ? [key] : [];
}

/**
 * Testable entry point. `ledgerRoot` is REQUIRED: only the CLI wrapper passes
 * defaultLedgerRoot(); tests pass a temporary directory, and
 * resolveLedgerRoots refuses the real ledger under Vitest.
 */
export async function main(argv: string[], ledgerRoot: string): Promise<number> {
  let values: { execute?: boolean; reconcile?: boolean; 'eval-root'?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        execute: { type: 'boolean', default: false },
        reconcile: { type: 'boolean', default: false },
        'eval-root': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }

  if (values.help) {
    console.log(usage());
    return 0;
  }
  if (values.execute && values.reconcile) throw new UsageError('--execute and --reconcile are mutually exclusive');

  const secrets = dedicatedKeySecrets();
  const report = (text: string) => console.error(redactKnownSecrets(text, secrets));
  const evalRoot = values['eval-root'] || DEFAULT_EVAL_ROOT;
  const roots = resolveLedgerRoots(evalRoot, ledgerRoot);

  const cases = loadCases(evalRoot);
  const plan = buildExperimentPlan(cases); // throws if > 24 pairs — validated before any ledger access.
  const planPairs = plan.map((p) => ({ caseId: p.case_id, model: p.model }));

  const layoutProblems = inspectLedgerLayout(roots);
  if (layoutProblems.length > 0) {
    report('Request ledger cannot be used (nothing was changed):');
    for (const p of layoutProblems) report(`  ${p}`);
    return 1;
  }

  const corrupt = findCorruptPairs(roots, planPairs);
  if (corrupt.length > 0) {
    report('Ledger consistency problems detected:');
    for (const p of corrupt) report(`  ${p.caseId} x ${p.model}: ${p.problem}`);
  }

  printPlan(roots, plan);

  if (!values.execute && !values.reconcile) {
    console.log('');
    console.log('DRY RUN — read-only: no network calls were made, nothing was written, and no API key was used.');
    console.log('Pass --execute (with GEMINI_QUALITY_EVAL_API_KEY set) to run requests, or --reconcile for offline recovery.');
    return corrupt.length > 0 ? 1 : 0;
  }
  if (corrupt.length > 0) {
    report('Refusing to write with inconsistent ledger state. Investigate manually — nothing was reset or repeated.');
    return 1;
  }

  let apiKey: string | null = null;
  if (values.execute) {
    const keyResolution = resolveExecutionApiKey(process.env);
    if (!keyResolution.ok) throw new UsageError(keyResolution.error);
    apiKey = keyResolution.key;
  }

  await ensureLedgerDirs(roots);
  const reconciled = await reconcileAndMaterialize(roots, cases, planPairs);
  for (const label of reconciled.reconciled) console.log(`Reconciled ${label}: completion recorded from its verified saved output.`);
  for (const label of reconciled.materialized) console.log(`Copied verified output for ${label} into ${roots.localOutputsDir}.`);
  for (const w of reconciled.warnings) report(`Warning: ${w}`);
  if (reconciled.problems.length > 0) {
    report('Reconciliation problems (nothing was repaired or repeated):');
    for (const p of reconciled.problems) report(`  ${p}`);
    return 1;
  }

  const ok = apiKey === null ? true : await runExperiment(roots, cases, plan, apiKey);
  printSummary(roots, plan);
  return ok ? 0 : 1;
}

/**
 * main() plus exit-code mapping and error printing for the CLI wrapper. Every
 * printed error has the exact dedicated API key removed (not only key-shaped
 * patterns). Never reads GEMINI_API_KEY.
 */
export async function runCli(argv: string[], ledgerRoot: string): Promise<number> {
  try {
    return await main(argv, ledgerRoot);
  } catch (err) {
    const secrets = dedicatedKeySecrets();
    if (err instanceof UsageError || err instanceof UnknownPairError) {
      console.error(`Error: ${safeErrorMessage(err, secrets)}\n\n${usage()}`);
      return 2;
    }
    console.error(`Unexpected error: ${safeErrorMessage(err, secrets)}`);
    return 1;
  }
}
