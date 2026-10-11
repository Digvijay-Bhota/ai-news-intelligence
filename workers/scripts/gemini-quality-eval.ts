#!/usr/bin/env -S npx vite-node
/**
 * Offline Gemini quality-evaluation CLI.
 *
 * Run with: npx vite-node scripts/gemini-quality-eval.ts -- <command> [...]
 *
 * This tool never calls Gemini or any other network API. It only reads
 * local benchmark case fixtures, saved model outputs from the shared Phase 2
 * request ledger (read-only; each output is verified against the SHA-256 in
 * its completed run-log), and local human scorecard files, and writes local
 * scorecard files. It requires no credentials and does not touch Env, the
 * automatic escalation path, or any production system.
 *
 * Run via `vite-node` (a transitive dependency of vitest already present
 * after `npm ci` — no new package is added) so it can import the real
 * TypeScript validators directly, with full filesystem access, outside the
 * Workers test runtime (which does not implement fs.readFileSync).
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { defaultLedgerRoot, inspectLedgerLayout, resolveLedgerRoots, type LedgerRoots } from '../tests/gemini-quality-eval/ledger';
import { checkScorable, ledgerOutputSource } from '../tests/gemini-quality-eval/ledger-state';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  buildComparisonReport,
  checkCaseDocumentation,
  renderReport,
  validateHumanScore,
  validateCaseIdForWrite,
  isSupportedModel,
  EVAL_MODELS,
  type EvalCase,
  type EvalModel,
  type HumanScore,
  type ScoreLoadResult,
} from '../tests/gemini-quality-eval/harness';

const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL_ROOT = join(HERE, '..', 'tests', 'gemini-quality-eval');
const CASES_DIR = join(EVAL_ROOT, 'cases');
const DEFAULT_SCORES_DIR = join(EVAL_ROOT, 'scores');

class UsageError extends Error {}

const USAGE = `Offline Gemini quality-evaluation tool. Never calls Gemini or any network API.

Usage:
  npx vite-node scripts/gemini-quality-eval.ts -- report [--scores-dir <dir>] [--json]
  npx vite-node scripts/gemini-quality-eval.ts -- check-cases
  npx vite-node scripts/gemini-quality-eval.ts -- score <case-id> <model> --reviewer <name>
      --factual <1-5> --preservation <1-5> --unsupported <1-5> --uncertainty <1-5> --usefulness <1-5>
      --verdict <pass|fail|needs_review> --justification "<text>"
      [--invented "<item1>|<item2>"] [--missing "<item1>|<item2>"]
      [--scores-dir <dir>]

Saved outputs are read only from the shared request ledger
(${defaultLedgerRoot()}), never from a local outputs/ copy.

Commands:
  report        Build and print the comparison report for all 12 cases against
                 verified saved outputs/scores. Unattempted pairs are "missing";
                 failed, ambiguous, incomplete and corrupt pairs are reported as such.
  check-cases    Validate that every case fixture carries the documentation this
                 benchmark requires (does not touch outputs or scores).
  score          Record one human reviewer's score for a (case, model) pair that
                 has a verified, mechanically-valid saved output in the ledger.

Exit codes: 0 success, 1 runtime error, 2 usage error.`;

function loadCases(): EvalCase[] {
  const files = readdirSync(CASES_DIR).filter((f) => f.endsWith('.json'));
  return files.map((f) => JSON.parse(readFileSync(join(CASES_DIR, f), 'utf8')) as EvalCase);
}

/** Read-only access to the shared ledger; null (after printing why) if its layout is unusable. */
function openLedgerReadOnly(): LedgerRoots | null {
  const roots = resolveLedgerRoots(EVAL_ROOT, defaultLedgerRoot());
  const problems = inspectLedgerLayout(roots);
  if (problems.length === 0) return roots;
  console.error('Request ledger cannot be read:');
  for (const p of problems) console.error(`  ${p}`);
  return null;
}

function readScore(scoresDir: string, caseId: string, model: EvalModel): ScoreLoadResult {
  const path = join(scoresDir, `${caseId}.${model}.score.json`);
  if (!existsSync(path)) return { status: 'none' };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    // A scorecard that isn't even valid JSON must never abort the whole
    // report — it is reported as 'corrupt' for this one (case, model) pair
    // only, and processing continues for every other pair.
    return { status: 'corrupt', error: `Scorecard is not valid JSON: ${e instanceof Error ? e.message : 'unknown error'}` };
  }
  const validated = validateHumanScore(raw);
  if (!validated.valid) {
    // Syntactically valid JSON that is missing required fields, has an
    // out-of-range score, or has the wrong field types is never silently
    // treated as a complete scorecard — it is reported as 'corrupt' too.
    return { status: 'corrupt', error: validated.errors.join('; ') };
  }
  return { status: 'valid', score: validated.score };
}

function cmdReport(values: Record<string, unknown>): number {
  const scoresDir = (values['scores-dir'] as string) || DEFAULT_SCORES_DIR;
  const roots = openLedgerReadOnly();
  if (!roots) return 1;
  const cases = loadCases();
  const source = ledgerOutputSource(roots);
  const results = buildComparisonReport(
    cases,
    source.readOutput,
    (caseId, model) => readScore(scoresDir, caseId, model),
    source.explainUnavailable
  );
  if (values.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(renderReport(cases, results));
  }
  return 0;
}

function cmdCheckCases(): number {
  const cases = loadCases();
  let problems = 0;
  const taskCounts: Record<string, number> = {};
  for (const c of cases) {
    taskCounts[c.task] = (taskCounts[c.task] ?? 0) + 1;
    const caseProblems = checkCaseDocumentation(c);
    if (caseProblems.length > 0) {
      problems += caseProblems.length;
      console.error(`${c.id}: ${caseProblems.join('; ')}`);
    }
  }
  console.log(`Loaded ${cases.length} cases. Task distribution: ${JSON.stringify(taskCounts)}.`);
  if (problems > 0) {
    console.error(`${problems} documentation problem(s) found.`);
    return 1;
  }
  console.log('All cases carry the required documentation.');
  return 0;
}

function cmdScore(positionals: string[], values: Record<string, unknown>): number {
  const [caseId, model] = positionals;
  if (!caseId || !model) throw new UsageError('score requires <case-id> and <model>');

  // Both checks happen before any path is built. caseId is validated against
  // the real, loaded case IDs (never just "looks safe"); model is checked
  // against the explicit runtime allowlist, never inferred from a
  // TypeScript cast.
  const cases = loadCases();
  const knownCaseIds = new Set(cases.map((c) => c.id));
  const caseIdCheck = validateCaseIdForWrite(caseId, knownCaseIds);
  if (!caseIdCheck.valid) throw new UsageError(caseIdCheck.error!);
  if (!isSupportedModel(model)) {
    throw new UsageError(`model must be one of: ${EVAL_MODELS.join(', ')}`);
  }
  const roots = openLedgerReadOnly();
  if (!roots) return 1;
  const scorable = checkScorable(roots, cases.find((c) => c.id === caseId)!, model);
  if (!scorable.ok) {
    console.error(`Cannot score ${caseId} x ${model}: ${scorable.reason}`);
    return 1;
  }
  const required = ['reviewer', 'factual', 'preservation', 'unsupported', 'uncertainty', 'usefulness', 'verdict', 'justification'];
  for (const key of required) {
    if (values[key] === undefined) throw new UsageError(`--${key} is required`);
  }
  const score: HumanScore = {
    reviewer: String(values.reviewer),
    factual_consistency: Number(values.factual),
    information_preservation: Number(values.preservation),
    unsupported_claims: Number(values.unsupported),
    uncertainty_handling: Number(values.uncertainty),
    usefulness: Number(values.usefulness),
    invented_claims_found: values.invented ? String(values.invented).split('|').filter(Boolean) : [],
    missing_facts_found: values.missing ? String(values.missing).split('|').filter(Boolean) : [],
    justification: String(values.justification),
    overall_verdict: values.verdict as HumanScore['overall_verdict'],
  };
  for (const [field, v] of Object.entries(score)) {
    if (typeof v === 'number' && (!Number.isInteger(v) || v < 1 || v > 5)) {
      throw new UsageError(`${field} must be an integer between 1 and 5`);
    }
  }
  if (!['pass', 'fail', 'needs_review'].includes(score.overall_verdict)) {
    throw new UsageError('--verdict must be pass, fail, or needs_review');
  }

  const scoresDir = (values['scores-dir'] as string) || DEFAULT_SCORES_DIR;
  mkdirSync(scoresDir, { recursive: true });
  const path = join(scoresDir, `${caseId}.${model}.score.json`);
  writeFileSync(path, JSON.stringify(score, null, 2) + '\n', 'utf8');
  console.log(`Recorded score at ${path}`);
  return 0;
}

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'scores-dir': { type: 'string' },
      json: { type: 'boolean', default: false },
      reviewer: { type: 'string' },
      factual: { type: 'string' },
      preservation: { type: 'string' },
      unsupported: { type: 'string' },
      uncertainty: { type: 'string' },
      usefulness: { type: 'string' },
      verdict: { type: 'string' },
      justification: { type: 'string' },
      invented: { type: 'string' },
      missing: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const [command, ...rest] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }

  if (command === 'report') return cmdReport(values);
  if (command === 'check-cases') return cmdCheckCases();
  if (command === 'score') return cmdScore(rest, values);
  throw new UsageError(`Unknown command: ${command}`);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  if (err instanceof UsageError || (err && typeof err === 'object' && 'code' in err && String((err as { code: unknown }).code).startsWith('ERR_PARSE_ARGS'))) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    process.exitCode = 2;
  } else {
    console.error('Unexpected error:', err instanceof Error ? err.message : 'unknown');
    process.exitCode = 1;
  }
}
