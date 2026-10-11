/**
 * Read-side state, verified output access and offline reconciliation for the
 * Phase 2 request ledger (see ledger.ts for the write primitives and layout).
 *
 * Nothing here sends a request, reserves a pair, claims budget, deletes a
 * file, or overwrites one. Every decision is made from ONE read of a pair's
 * canonical output bytes, so a hash check and the JSON that is returned can
 * never come from two different versions of the file.
 *
 * Only real fs is used, so like ledger.ts this runs under
 * vitest.ledger.config.ts rather than the Workers pool.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateSavedOutput, type EvalCase, type EvalModel, type UnavailableOutput } from './harness';
import { GeminiOutputValidationError } from '../../src/tasks/gemini-errors';
import {
  buildRunLogRecord,
  classifyPairState,
  outputFileName,
  parseModelText,
  rejectedOutputFileName,
  EXPERIMENT_ID,
  type PairState,
} from './runner';
import {
  hasReservation,
  readCanonicalOutputBytes,
  readRejectedOutputBytes,
  readReservedAt,
  readRunLog,
  sha256Hex,
  writeLocalCopyOnce,
  writeRunLogOnce,
  type LedgerRoots,
} from './ledger';

export interface PairStatus {
  state: PairState;
  problem: string | null;
}

/**
 * Reads the pair's files in REVERSE write order (run-log, saved output,
 * reservation). Files are never deleted, so anything written before a file we
 * saw is guaranteed to be visible too: a concurrent writer can make us see an
 * earlier state, but never a falsely corrupt one.
 */
function observe(
  roots: LedgerRoots,
  caseId: string,
  model: EvalModel
): { bytes: Buffer | null; rejected: Buffer | null } & PairStatus {
  const runLog = readRunLog(roots, caseId, model);
  const bytes = readCanonicalOutputBytes(roots, caseId, model);
  const rejected = readRejectedOutputBytes(roots, caseId, model);
  const reserved = hasReservation(roots, caseId, model);
  const status = classifyPairState({
    reserved,
    runLog,
    canonicalOutputSha256: bytes ? sha256Hex(bytes) : null,
    rejectedOutputSha256: rejected ? sha256Hex(rejected) : null,
  });
  return { bytes, rejected, ...status };
}

export function getPairStatus(roots: LedgerRoots, caseId: string, model: EvalModel): PairStatus {
  const { state, problem } = observe(roots, caseId, model);
  return { state, problem };
}

export function getPairState(roots: LedgerRoots, caseId: string, model: EvalModel): PairState {
  return getPairStatus(roots, caseId, model).state;
}

export type VerifiedOutput =
  | { ok: true; output: unknown; bytes: Buffer; sha256: string }
  | { ok: false; state: PairState; problem: string | null };

/**
 * The only way to read a saved output: the pair must be 'completed', the
 * canonical bytes must hash to the run-log's output_sha256, and they must
 * parse as JSON. Anything else is reported, never returned as an output.
 */
export function loadVerifiedOutput(roots: LedgerRoots, caseId: string, model: EvalModel): VerifiedOutput {
  const { bytes, state, problem } = observe(roots, caseId, model);
  if (state !== 'completed' || !bytes) return { ok: false, state, problem };
  try {
    return { ok: true, output: JSON.parse(bytes.toString('utf8')), bytes, sha256: sha256Hex(bytes) };
  } catch {
    return { ok: false, state: 'corrupt', problem: 'canonical output matches its hash but is not valid JSON' };
  }
}

/**
 * Reads a preserved invalid output: the pair must be 'invalid' and the raw
 * text must hash to the run-log's output_sha256. Returned for review only —
 * it is never treated as a valid output.
 */
export function loadVerifiedRejectedOutput(
  roots: LedgerRoots,
  caseId: string,
  model: EvalModel
): { ok: true; text: string; sha256: string; errors: string[] } | { ok: false; state: PairState; problem: string | null } {
  const { rejected, state, problem } = observe(roots, caseId, model);
  if (state !== 'invalid' || !rejected) return { ok: false, state, problem };
  const log = readRunLog(roots, caseId, model);
  const errors = log.status === 'valid' ? log.record.mechanical_validation.errors : [];
  return { ok: true, text: rejected.toString('utf8'), sha256: sha256Hex(rejected), errors };
}

/** Every planned pair whose ledger state is corrupt, with the precise reason. */
export function findCorruptPairs(
  roots: LedgerRoots,
  pairs: ReadonlyArray<{ caseId: string; model: EvalModel }>
): Array<{ caseId: string; model: EvalModel; problem: string }> {
  const out: Array<{ caseId: string; model: EvalModel; problem: string }> = [];
  for (const { caseId, model } of pairs) {
    const { state, problem } = getPairStatus(roots, caseId, model);
    if (state === 'corrupt') out.push({ caseId, model, problem: problem ?? 'corrupt ledger state' });
  }
  return out;
}

/** Maps a non-completed (or unreadable) pair to the report status that describes it. */
function describeUnavailable(roots: LedgerRoots, caseId: string, model: EvalModel): UnavailableOutput {
  const verified = loadVerifiedOutput(roots, caseId, model);
  if (verified.ok) return { status: 'corrupt_output', detail: 'output became readable between checks; re-run the report' };
  switch (verified.state) {
    case 'not_attempted':
      return { status: 'missing', detail: null };
    case 'failed': {
      const log = readRunLog(roots, caseId, model);
      const record = log.status === 'valid' ? log.record : null;
      const cls = record?.error_classification?.classification ?? 'unknown';
      return { status: 'failed', detail: `request failed (${cls})${record?.error_message ? `: ${record.error_message}` : ''}` };
    }
    case 'invalid': {
      const rejected = loadVerifiedRejectedOutput(roots, caseId, model);
      if (!rejected.ok) return { status: 'corrupt_output', detail: rejected.problem ?? 'rejected output unreadable' };
      const path = join(roots.rejectedOutputsDir, rejectedOutputFileName(caseId, model));
      return {
        status: 'invalid',
        detail: `model output failed validation (${rejected.errors.join('; ') || 'no detail recorded'}); preserved for review at ${path} (sha256 ${rejected.sha256.slice(0, 12)}…)`,
      };
    }
    case 'ambiguous':
      return { status: 'ambiguous', detail: 'reserved but no outcome recorded (interrupted); never re-sent' };
    case 'incomplete':
      return { status: 'incomplete', detail: 'output saved but completion not recorded; run the comparison runner with --reconcile' };
    default:
      return { status: 'corrupt_output', detail: verified.problem ?? 'corrupt ledger state' };
  }
}

/**
 * Callbacks for harness.buildComparisonReport that read ONLY verified
 * canonical outputs from the shared ledger, so any checkout reports the same
 * results and a local outputs/ file can never be reported as valid.
 */
export function ledgerOutputSource(roots: LedgerRoots): {
  readOutput: (caseId: string, model: EvalModel) => unknown | null;
  explainUnavailable: (caseId: string, model: EvalModel) => UnavailableOutput;
} {
  return {
    readOutput: (caseId, model) => {
      const v = loadVerifiedOutput(roots, caseId, model);
      return v.ok ? v.output : null;
    },
    explainUnavailable: (caseId, model) => describeUnavailable(roots, caseId, model),
  };
}

/** Gate for the `score` command: only a verified, mechanically valid ledger output may be scored. */
export function checkScorable(roots: LedgerRoots, evalCase: EvalCase, model: EvalModel): { ok: true } | { ok: false; reason: string } {
  const v = loadVerifiedOutput(roots, evalCase.id, model);
  if (!v.ok) {
    return { ok: false, reason: `no verified saved output (ledger state: ${v.state}${v.problem ? ` — ${v.problem}` : ''})` };
  }
  const validation = validateSavedOutput(evalCase, v.output);
  if (!validation.valid) return { ok: false, reason: `saved output fails mechanical validation: ${validation.errors[0]}` };
  return { ok: true };
}

export type MaterializeResult = 'written' | 'already_matches' | 'local_differs';

/**
 * Ensures this checkout's outputs/ holds a copy of already-verified canonical
 * bytes. Never overwrites: a differing local file is reported and left alone
 * (the ledger copy stays authoritative).
 */
export async function materializeLocalCopy(
  roots: LedgerRoots,
  caseId: string,
  model: EvalModel,
  bytes: Buffer
): Promise<MaterializeResult> {
  const localPath = join(roots.localOutputsDir, outputFileName(caseId, model));
  if (!existsSync(localPath) && (await writeLocalCopyOnce(roots, caseId, model, bytes)) === 'written') return 'written';
  return sha256Hex(readFileSync(localPath)) === sha256Hex(bytes) ? 'already_matches' : 'local_differs';
}

export interface ReconcileReport {
  /** Pairs whose missing completion record was written from a verified canonical output. */
  reconciled: string[];
  /** Pairs whose local outputs/ copy was created. */
  materialized: string[];
  /** Non-blocking notes about local copies (never authoritative). */
  warnings: string[];
  /** Blocking problems. Nothing was repaired for these pairs. */
  problems: string[];
}

/**
 * Offline recovery after a crash, and local materialization for any
 * checkout. Never sends a request and never repeats a reserved one:
 *   - 'incomplete' (reservation + one saved output, no run-log): a canonical
 *     output is re-validated against this checkout's case fixture and, only
 *     if valid, a 'completed' record is written; a rejected output is
 *     re-checked and, only if it still fails validation, an 'invalid' record
 *     is written. Both carry the output's SHA-256 and reconciled: true.
 *     Anything else is reported and left untouched.
 *   - 'completed': the verified bytes are copied to the local outputs/.
 *   - every other state is left exactly as it is.
 */
export async function reconcileAndMaterialize(
  roots: LedgerRoots,
  cases: ReadonlyArray<EvalCase>,
  pairs: ReadonlyArray<{ caseId: string; model: EvalModel }>
): Promise<ReconcileReport> {
  const report: ReconcileReport = { reconciled: [], materialized: [], warnings: [], problems: [] };
  const casesById = new Map(cases.map((c) => [c.id, c]));
  for (const { caseId, model } of pairs) {
    const label = `${caseId} x ${model}`;
    const evalCase = casesById.get(caseId);
    let { bytes, rejected, state, problem } = observe(roots, caseId, model);

    if (state === 'incomplete' && rejected && evalCase) {
      const parsed = parseModelText(rejected.toString('utf8'));
      const validation = parsed.ok
        ? validateSavedOutput(evalCase, parsed.value)
        : { valid: false, errors: ['Invalid JSON returned by Gemini API'] };
      if (validation.valid) {
        report.problems.push(`${label}: interrupted run left a rejected output that now passes validation; left untouched`);
        continue;
      }
      const record = buildRunLogRecord({
        experimentId: EXPERIMENT_ID,
        caseId,
        task: evalCase.task,
        model,
        reservedAt: readReservedAt(roots, caseId, model) ?? 'unknown',
        responseMeta: null,
        outcome: 'invalid',
        error: new GeminiOutputValidationError(validation.errors[0] ?? 'Mechanical validation failed'),
        validation,
        outputSha256: sha256Hex(rejected),
        reconciled: true,
      });
      await writeRunLogOnce(roots, caseId, model, record); // 'already_exists' = a concurrent writer; re-checked below
      ({ bytes, rejected, state, problem } = observe(roots, caseId, model));
      if (state === 'invalid') report.reconciled.push(label);
    }

    if (state === 'incomplete' && bytes && evalCase) {
      let output: unknown;
      try {
        output = JSON.parse(bytes.toString('utf8'));
      } catch {
        report.problems.push(`${label}: interrupted run left a canonical output that is not valid JSON; left untouched`);
        continue;
      }
      const validation = validateSavedOutput(evalCase, output);
      if (!validation.valid) {
        report.problems.push(`${label}: interrupted run left an output that fails validation (${validation.errors[0]}); left untouched`);
        continue;
      }
      const record = buildRunLogRecord({
        experimentId: EXPERIMENT_ID,
        caseId,
        task: evalCase.task,
        model,
        reservedAt: readReservedAt(roots, caseId, model) ?? 'unknown',
        responseMeta: null,
        outcome: 'completed',
        validation,
        outputSha256: sha256Hex(bytes),
        reconciled: true,
      });
      await writeRunLogOnce(roots, caseId, model, record); // 'already_exists' = a concurrent writer; re-checked below
      ({ bytes, rejected, state, problem } = observe(roots, caseId, model));
      if (state === 'completed') report.reconciled.push(label);
    }

    if (state === 'corrupt' || (state === 'incomplete' && !evalCase)) {
      report.problems.push(`${label}: ${problem ?? 'cannot reconcile: case fixture not found in this checkout'}`);
      continue;
    }
    const localPath = join(roots.localOutputsDir, outputFileName(caseId, model));
    if (state !== 'completed' || !bytes) {
      if (existsSync(localPath)) {
        report.warnings.push(`${label}: local file ${localPath} is not backed by a completed ledger entry (state: ${state}); ignored`);
      }
      continue;
    }
    const result = await materializeLocalCopy(roots, caseId, model, bytes);
    if (result === 'written') report.materialized.push(label);
    if (result === 'local_differs') {
      report.warnings.push(`${label}: local file ${localPath} differs from the canonical ledger output; left unchanged (ledger is authoritative)`);
    }
  }
  return report;
}
