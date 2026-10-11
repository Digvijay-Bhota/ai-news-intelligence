/**
 * Durable, cross-process-safe request ledger for the Phase 2 comparison
 * experiment.
 *
 * This file does real, synchronous-free filesystem I/O and is therefore NOT
 * testable inside the `@cloudflare/vitest-pool-workers` pool used for the
 * rest of this repo's Workers tests (that runtime does not implement
 * fs.promises). It is tested separately via `vitest.ledger.config.ts`,
 * which runs in a plain Node environment with real fs access — see
 * tests/gemini-quality-eval-ledger.test.ts.
 *
 * Why a ledger file per (case, model) pair, plus a separate set of numbered
 * budget-slot files, rather than an in-memory counter or a single shared
 * counter file:
 *
 *   - A reservation for one (case, model) pair is "create this exact file,
 *     and fail loudly if it already exists" via Node's `wx` flag
 *     (O_CREAT | O_EXCL). That create is atomic at the OS level: when two
 *     processes race to create the SAME path, the OS guarantees exactly one
 *     of them succeeds — no read-then-write window, no separate lock file,
 *     no new dependency.
 *   - The TOTAL cap across ALL pairs is enforced the same way, not by
 *     reading and comparing a count (which has a race window: two
 *     concurrent callers for two DIFFERENT pairs could both observe "room
 *     left" before either of their writes lands, and both proceed). Instead
 *     each reservation must first atomically claim one of exactly
 *     MAX_EXPERIMENT_REQUESTS pre-named, numbered slot files
 *     (_slot-00.claim .. _slot-23.claim). Since each slot filename can only
 *     ever be created once, the number of successful claims — across any
 *     number of processes, for any number of distinct pairs — can never
 *     exceed MAX_EXPERIMENT_REQUESTS. See claimBudgetSlot below.
 *   - The ledger (budget slots, reservations, run-logs) lives in ONE fixed,
 *     user-level directory — defaultLedgerRoot(), under the OS user's home
 *     directory — not inside the repository. Every worktree, clone, and
 *     --eval-root of this project on the same machine and OS account
 *     therefore shares one budget AND one view of which pairs were already
 *     attempted: switching checkout cannot hand out another 24 requests or
 *     re-send a failed/ambiguous pair. There is deliberately no CLI flag or
 *     environment variable that relocates it. The slot files sit in one
 *     request-budget/ directory shared by every --experiment-id, so renaming
 *     the experiment cannot obtain a fresh budget either.
 *     Limitation: this is a local file ledger. It cannot coordinate across
 *     different physical machines (or different OS user accounts); each of
 *     those has its own ledger and its own 24-request budget.
 *   - Every ledger file is created and then fsync'd, together with its
 *     parent directory, before the call returns. Without that, a power loss
 *     after the request was sent could leave the reservation missing on
 *     disk after reboot, and the pair would look 'not_attempted' again.
 *   - Neither a pair reservation nor a claimed slot is ever deleted by this
 *     module — there is no "refund" or "reset" operation at all. Once a
 *     pair is reserved, it stays reserved forever (from this ledger's point
 *     of view), whether the attempt that followed succeeded, failed, or the
 *     process crashed mid-request. A restart that finds a reservation with
 *     no run-log for that pair reports it as 'ambiguous' and does not touch
 *     it. In the rare case where two concurrent callers raced for the same
 *     pair, the loser's claimed slot is simply spent and not reused — a
 *     safe trade-off that can only under-use the budget, never exceed it.
 *   - Output files and run-log files use the identical atomic-create
 *     pattern, so a second attempt to write either for an already-completed
 *     pair fails loudly instead of silently overwriting.
 */

import { mkdirSync, existsSync, readFileSync, readdirSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  isSupportedModel,
  validateCaseIdForWrite,
  type EvalModel,
} from './harness';
import {
  MAX_EXPERIMENT_REQUESTS,
  outputFileName,
  reservationFileName,
  runLogFileName,
  parseReservationFileName,
  classifyPairState,
  type RunLogRecord,
  type PairState,
} from './runner';

export interface LedgerRoots {
  /** <ledger-root>/request-budget — shared by ALL experiment IDs and checkouts. */
  budgetDir: string;
  /** <ledger-root>/experiments/<experiment-id>/reservations */
  reservationsDir: string;
  /** <ledger-root>/experiments/<experiment-id>/run-logs */
  runLogsDir: string;
  /** <eval-root>/outputs — the existing, flat Phase 1 outputs/ directory, reused as-is. */
  outputsDir: string;
}

/**
 * The single user-level ledger location for this machine and OS account:
 * ~/.local/state/ai-news-intelligence/gemini-quality-eval. The home
 * directory comes from the OS user database (os.userInfo), NOT $HOME, so
 * an environment tweak such as `HOME=/tmp/x` cannot point execution at a
 * fresh, empty ledger.
 */
export function defaultLedgerRoot(): string {
  return join(userInfo().homedir, '.local', 'state', 'ai-news-intelligence', 'gemini-quality-eval');
}

export function resolveLedgerRoots(evalRoot: string, experimentId: string, ledgerRoot: string): LedgerRoots {
  const ledger = resolve(ledgerRoot);
  const experimentRoot = join(ledger, 'experiments', experimentId);
  return {
    budgetDir: join(ledger, 'request-budget'),
    reservationsDir: join(experimentRoot, 'reservations'),
    runLogsDir: join(experimentRoot, 'run-logs'),
    outputsDir: join(resolve(evalRoot), 'outputs'),
  };
}

/** fsyncs a directory so entries just created in it survive a power loss. */
function syncDirectorySync(dir: string): void {
  // Windows cannot open a directory for fsync; POSIX requires it for durability.
  if (process.platform === 'win32') return;
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function ensureLedgerDirs(roots: LedgerRoots): void {
  for (const dir of [roots.budgetDir, roots.reservationsDir, roots.runLogsDir, roots.outputsDir]) {
    const firstCreated = mkdirSync(dir, { recursive: true });
    // Persist `dir` and every directory entry this call created (up to and
    // including the pre-existing parent of the first new directory), so a
    // freshly created ledger tree cannot vanish on power loss.
    const stopAt = firstCreated ? dirname(firstCreated) : dir;
    for (let d = dir; ; d = dirname(d)) {
      syncDirectorySync(d);
      if (d === stopAt || dirname(d) === d) break;
    }
  }
}

/**
 * Exclusively creates `path` (`wx`, so it fails with EEXIST if the file
 * already exists), writes `contents`, and fsyncs the file and its parent
 * directory before returning.
 */
async function createFileDurably(path: string, contents: string): Promise<void> {
  const handle = await open(path, 'wx');
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  syncDirectorySync(dirname(path));
}

/** Thrown when the caller passes an unvalidated/unknown case ID or model. Never caught silently. */
export class UnknownPairError extends Error {}

function assertKnownPair(caseId: string, model: string, knownCaseIds: ReadonlySet<string>): asserts model is EvalModel {
  const caseCheck = validateCaseIdForWrite(caseId, knownCaseIds);
  if (!caseCheck.valid) throw new UnknownPairError(caseCheck.error ?? `Invalid case ID: ${caseId}`);
  if (!isSupportedModel(model)) throw new UnknownPairError(`Unsupported model: ${model}`);
}

/** True if a file exists at `path` — used only for read-side state checks, never for a write decision. */
function fileExists(path: string): boolean {
  return existsSync(path);
}

export function hasReservation(roots: LedgerRoots, caseId: string, model: EvalModel): boolean {
  return fileExists(join(roots.reservationsDir, reservationFileName(caseId, model)));
}

export function readRunLog(roots: LedgerRoots, caseId: string, model: EvalModel): RunLogRecord | null {
  const path = join(roots.runLogsDir, runLogFileName(caseId, model));
  if (!fileExists(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RunLogRecord;
  } catch {
    // A corrupt run-log must never be mistaken for "no run-log" (ambiguous)
    // or silently treated as completed. Surface it distinctly to the caller.
    throw new Error(`Run-log for ${caseId}.${model} exists but is not valid JSON — refusing to proceed.`);
  }
}

export function hasOutput(roots: LedgerRoots, caseId: string, model: EvalModel): boolean {
  return fileExists(join(roots.outputsDir, outputFileName(caseId, model)));
}

export function getPairState(roots: LedgerRoots, caseId: string, model: EvalModel): PairState {
  return classifyPairState(hasReservation(roots, caseId, model), readRunLog(roots, caseId, model));
}

/** Every reservation filename currently on disk that parses as a valid (case, model) pair. */
export function listReservedPairs(roots: LedgerRoots): Array<{ caseId: string; model: EvalModel }> {
  if (!existsSync(roots.reservationsDir)) return [];
  const names = readdirSync(roots.reservationsDir);
  const pairs: Array<{ caseId: string; model: EvalModel }> = [];
  for (const name of names) {
    const parsed = parseReservationFileName(name);
    if (parsed) pairs.push(parsed);
  }
  return pairs;
}

export function countReservations(roots: LedgerRoots): number {
  return listReservedPairs(roots).length;
}

export type ReserveResult =
  | { ok: true; reservedAt: string }
  | { ok: false; reason: 'already_reserved' }
  | { ok: false; reason: 'cap_reached'; count: number };

/**
 * Atomically reserves one (case, model) pair, persisting the reservation to
 * disk BEFORE the caller is allowed to send any network request. Safe to
 * call from multiple concurrent processes pointed at the same ledger
 * directory: the underlying `wx` open is a single atomic OS-level
 * create-or-fail, so two processes racing for the same pair can never both
 * "win". Never refunds; there is deliberately no corresponding "release" or
 * "reset" function anywhere in this module.
 */
function isEexist(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && (err as { code: unknown }).code === 'EEXIST');
}

/**
 * Atomically claims one of exactly MAX_EXPERIMENT_REQUESTS pre-named budget
 * slots, trying each in order and taking the first not already claimed.
 * Each slot filename is only ever created once (`wx`), so the TOTAL number
 * of slot claims that can ever succeed — across any number of concurrent
 * processes, for any number of distinct (case, model) pairs — is bounded at
 * exactly MAX_EXPERIMENT_REQUESTS. This is what makes the overall cap
 * race-proof: unlike a read-count-then-write check (which has a window
 * where two concurrent callers can both observe room and both proceed),
 * claiming a uniquely-named slot is a single atomic OS-level operation with
 * no read step to race on. Returns the claimed slot index, or null if every
 * slot is already claimed.
 */
async function claimBudgetSlot(roots: LedgerRoots, claimRecord: string): Promise<number | null> {
  for (let i = 0; i < MAX_EXPERIMENT_REQUESTS; i++) {
    const path = join(roots.budgetDir, `_slot-${String(i).padStart(2, '0')}.claim`);
    try {
      await createFileDurably(path, claimRecord);
      return i;
    } catch (err: unknown) {
      if (isEexist(err)) continue;
      throw err;
    }
  }
  return null;
}

export async function reserveNext(
  roots: LedgerRoots,
  caseId: string,
  model: string,
  knownCaseIds: ReadonlySet<string>
): Promise<ReserveResult> {
  assertKnownPair(caseId, model, knownCaseIds);

  const path = join(roots.reservationsDir, reservationFileName(caseId, model));

  // Fast-path only — avoids wasting a budget slot on an attempt that is
  // already known-duplicate. Not load-bearing for correctness: the atomic
  // create below is what actually prevents the same pair being reserved
  // twice, even if two callers both pass this check concurrently.
  if (existsSync(path)) {
    return { ok: false, reason: 'already_reserved' };
  }

  const reservedAt = new Date().toISOString();
  const slot = await claimBudgetSlot(
    roots,
    JSON.stringify({ case_id: caseId, model, claimed_at: reservedAt, pid: process.pid }, null, 2)
  );
  if (slot === null) {
    return { ok: false, reason: 'cap_reached', count: MAX_EXPERIMENT_REQUESTS };
  }

  const record = JSON.stringify({ case_id: caseId, model, reserved_at: reservedAt, pid: process.pid, slot }, null, 2);
  try {
    await createFileDurably(path, record);
  } catch (err: unknown) {
    if (isEexist(err)) {
      // Lost the race for this exact pair to a concurrent caller between our
      // check above and now. The budget slot we claimed is spent and never
      // refunded (see module docs) — a conservative, safe trade-off that
      // never lets total successful reservations exceed the cap.
      return { ok: false, reason: 'already_reserved' };
    }
    throw err;
  }
  return { ok: true, reservedAt };
}

export type WriteOnceResult = 'written' | 'already_exists';

async function writeOnce(path: string, contents: string): Promise<WriteOnceResult> {
  try {
    await createFileDurably(path, contents);
    return 'written';
  } catch (err: unknown) {
    if (isEexist(err)) {
      return 'already_exists';
    }
    throw err;
  }
}

/** Refuses to overwrite an existing run-log for this pair. */
export async function writeRunLogOnce(roots: LedgerRoots, caseId: string, model: EvalModel, record: RunLogRecord): Promise<WriteOnceResult> {
  const path = join(roots.runLogsDir, runLogFileName(caseId, model));
  return writeOnce(path, JSON.stringify(record, null, 2) + '\n');
}

/** Refuses to overwrite an existing output for this pair (shared outputs/ convention from Phase 1). */
export async function writeOutputOnce(roots: LedgerRoots, caseId: string, model: EvalModel, output: unknown): Promise<WriteOnceResult> {
  const path = join(roots.outputsDir, outputFileName(caseId, model));
  return writeOnce(path, JSON.stringify(output, null, 2) + '\n');
}

export interface ConsistencyProblem {
  caseId: string;
  model: EvalModel;
  problem: string;
}

/**
 * Scans the ledger for states that should be structurally impossible given
 * this module's write order (reservation, then run-log, then — only on
 * success — output). Never attempts to fix anything it finds; the caller
 * must fail safely and stop rather than reset or guess.
 */
export function checkLedgerConsistency(
  roots: LedgerRoots,
  allPairs: Array<{ caseId: string; model: EvalModel }>
): ConsistencyProblem[] {
  const problems: ConsistencyProblem[] = [];
  for (const { caseId, model } of allPairs) {
    const reserved = hasReservation(roots, caseId, model);
    let runLog: RunLogRecord | null = null;
    try {
      runLog = readRunLog(roots, caseId, model);
    } catch (e) {
      problems.push({ caseId, model, problem: e instanceof Error ? e.message : 'Corrupt run-log' });
      continue;
    }
    const output = hasOutput(roots, caseId, model);
    if (runLog && !reserved) {
      problems.push({ caseId, model, problem: 'Run-log exists without a corresponding reservation' });
    }
    if (output && (!runLog || runLog.outcome !== 'completed')) {
      problems.push({ caseId, model, problem: 'Output exists without a matching completed run-log' });
    }
    if (runLog && runLog.outcome === 'completed' && !output) {
      problems.push({ caseId, model, problem: 'Run-log reports completed but no output file exists' });
    }
  }
  return problems;
}
