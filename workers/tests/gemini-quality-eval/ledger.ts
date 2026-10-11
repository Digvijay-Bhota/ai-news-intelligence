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
 *     and fail loudly if it already exists". Every ledger file is published
 *     with link() from a fully written temp file (createFileDurably), which
 *     is atomic and exclusive at the OS level: when two processes race to
 *     create the SAME path, exactly one succeeds — no read-then-write window,
 *     no separate lock file, no new dependency.
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
 *     re-send a pair. There is deliberately no CLI flag or environment
 *     variable that relocates it. Reservations, run-logs and canonical
 *     outputs are keyed globally by (case, model) — there is no experiment
 *     namespace — so nothing can re-open an already reserved pair.
 *   - A LEDGER_FORMAT marker identifies this layout. A ledger without it
 *     (e.g. the per-experiment layout written by the first version of this
 *     runner) is refused, never migrated, reset or deleted automatically.
 *   - Successful outputs are stored canonically IN the ledger (write-once,
 *     fsync'd) before the completing run-log, which records their SHA-256.
 *     Output that fails mechanical validation is preserved the same way in
 *     rejected-outputs/ (the model's raw text), recorded as 'invalid'.
 *     A checkout's local outputs/ directory only holds convenience copies of
 *     valid outputs.
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
 *
 * Pair state classification, reconciliation and verified reads live in
 * ledger-state.ts.
 */

import { mkdirSync, existsSync, readFileSync, readdirSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { link, open, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
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
  rejectedOutputFileName,
  reservationFileName,
  runLogFileName,
  parseReservationFileName,
  parseRunLogRecord,
  type RunLogObservation,
  type RunLogRecord,
} from './runner';

export interface LedgerRoots {
  ledgerRoot: string;
  /** <ledger-root>/request-budget — the 24 slot files, shared by every checkout. */
  budgetDir: string;
  /** <ledger-root>/reservations/<case>.<model>.reserved */
  reservationsDir: string;
  /** <ledger-root>/run-logs/<case>.<model>.run.json */
  runLogsDir: string;
  /** <ledger-root>/outputs/<case>.<model>.json — the authoritative saved (valid) outputs. */
  canonicalOutputsDir: string;
  /** <ledger-root>/rejected-outputs/<case>.<model>.rejected.txt — raw model text that failed validation. */
  rejectedOutputsDir: string;
  /** <eval-root>/outputs — this checkout's convenience copies; never authoritative. */
  localOutputsDir: string;
}

export const LEDGER_FORMAT_FILE = 'LEDGER_FORMAT';
const LEDGER_FORMAT = { format: 'gemini-quality-eval-request-ledger', version: 2 };
const LEDGER_FORMAT_TEXT = JSON.stringify(LEDGER_FORMAT, null, 2) + '\n';
/** Prefix of createFileDurably's private temp files; never read as ledger content. */
const TEMP_PREFIX = '.tmp-';
/** Top-level entries a format-2 ledger may contain. */
const LEDGER_ENTRIES = new Set([LEDGER_FORMAT_FILE, 'request-budget', 'reservations', 'run-logs', 'outputs', 'rejected-outputs']);

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

/** Thrown when code running under Vitest tries to address the real user-level ledger. */
export class RealLedgerInTestError extends Error {}

/**
 * Every ledger access goes through here. Under Vitest (which sets VITEST in
 * every test worker) the real user-level ledger is refused outright, so a
 * test can never claim real budget slots — even by mistake.
 */
export function resolveLedgerRoots(evalRoot: string, ledgerRoot: string): LedgerRoots {
  if (typeof ledgerRoot !== 'string' || ledgerRoot.trim() === '') {
    throw new TypeError('An explicit ledger root is required');
  }
  const ledger = resolve(ledgerRoot);
  if (process.env.VITEST !== undefined && ledger === resolve(defaultLedgerRoot())) {
    throw new RealLedgerInTestError(`Refusing to use the real user-level ledger (${ledger}) from a test run`);
  }
  return {
    ledgerRoot: ledger,
    budgetDir: join(ledger, 'request-budget'),
    reservationsDir: join(ledger, 'reservations'),
    runLogsDir: join(ledger, 'run-logs'),
    canonicalOutputsDir: join(ledger, 'outputs'),
    rejectedOutputsDir: join(ledger, 'rejected-outputs'),
    localOutputsDir: join(resolve(evalRoot), 'outputs'),
  };
}

/**
 * Read-only check that the ledger directory is either absent/empty or a
 * format-2 ledger. Returns precise problems; never changes anything.
 */
export function inspectLedgerLayout(roots: LedgerRoots): string[] {
  if (!existsSync(roots.ledgerRoot)) return [];
  // In-flight or crash-leftover temp files from createFileDurably are inert.
  const entries = readdirSync(roots.ledgerRoot).filter((e) => !e.startsWith(TEMP_PREFIX));
  if (entries.length === 0) return [];
  const problems: string[] = [];
  if (entries.includes('experiments')) {
    problems.push(
      `${join(roots.ledgerRoot, 'experiments')} is the legacy per-experiment ledger layout (first runner version). ` +
        'It is incompatible because it allowed a pair to be re-requested under a new experiment ID. ' +
        'Nothing was changed; move the ledger directory aside manually after reviewing it.'
    );
  }
  const markerPath = join(roots.ledgerRoot, LEDGER_FORMAT_FILE);
  if (!existsSync(markerPath)) {
    problems.push(`${roots.ledgerRoot} has content but no ${LEDGER_FORMAT_FILE} marker; refusing to guess its layout.`);
  } else if (readFileSync(markerPath, 'utf8') !== LEDGER_FORMAT_TEXT) {
    problems.push(`${markerPath} does not identify a format-${LEDGER_FORMAT.version} ledger.`);
  }
  for (const entry of entries) {
    if (!LEDGER_ENTRIES.has(entry) && entry !== 'experiments') {
      problems.push(`Unexpected entry in ledger root: ${join(roots.ledgerRoot, entry)}`);
    }
  }
  return problems;
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

/**
 * Creates the ledger (format marker first, then its directories) and this
 * checkout's local outputs/ directory. Refuses — before writing anything — if
 * the existing ledger directory is not an empty or format-2 ledger, so a
 * marker is never stamped into a legacy or unknown layout.
 */
export async function ensureLedgerDirs(roots: LedgerRoots): Promise<void> {
  const before = inspectLedgerLayout(roots);
  if (before.length > 0) throw new Error(before.join(' '));
  ensureDirDurably(roots.ledgerRoot);
  try {
    await createFileDurably(join(roots.ledgerRoot, LEDGER_FORMAT_FILE), LEDGER_FORMAT_TEXT);
  } catch (err) {
    if (!isEexist(err)) throw err; // a concurrent process wrote it; re-checked below
  }
  const after = inspectLedgerLayout(roots);
  if (after.length > 0) throw new Error(after.join(' '));
  for (const dir of [
    roots.budgetDir,
    roots.reservationsDir,
    roots.runLogsDir,
    roots.canonicalOutputsDir,
    roots.rejectedOutputsDir,
    roots.localOutputsDir,
  ]) {
    ensureDirDurably(dir);
  }
}

function ensureDirDurably(dir: string): void {
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

/**
 * Exclusively creates `path` with `contents` (fails with EEXIST if it already
 * exists) and fsyncs it and its directory before returning. The content is
 * written and fsync'd to a private temp file first and then published with
 * link(), which is atomic and exclusive: another process can never observe a
 * partially written ledger file, and two writers can never both succeed.
 */
async function createFileDurably(path: string, contents: string): Promise<void> {
  const dir = dirname(path);
  const tmp = join(dir, `${TEMP_PREFIX}${process.pid}-${randomUUID()}`);
  const handle = await open(tmp, 'wx');
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(tmp, path);
  } finally {
    // A leftover temp file (e.g. after a crash right here) is inert: no
    // ledger reader ever looks at .tmp-* names.
    await unlink(tmp).catch(() => undefined);
  }
  syncDirectorySync(dir);
}

/** Thrown when the caller passes an unvalidated/unknown case ID or model. Never caught silently. */
export class UnknownPairError extends Error {}

function assertKnownPair(caseId: string, model: string, knownCaseIds: ReadonlySet<string>): asserts model is EvalModel {
  const caseCheck = validateCaseIdForWrite(caseId, knownCaseIds);
  if (!caseCheck.valid) throw new UnknownPairError(caseCheck.error ?? `Invalid case ID: ${caseId}`);
  if (!isSupportedModel(model)) throw new UnknownPairError(`Unsupported model: ${model}`);
}

export function sha256Hex(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function hasReservation(roots: LedgerRoots, caseId: string, model: EvalModel): boolean {
  return existsSync(join(roots.reservationsDir, reservationFileName(caseId, model)));
}

/** The reserved_at recorded in a pair's reservation file, or null if absent/unreadable. */
export function readReservedAt(roots: LedgerRoots, caseId: string, model: EvalModel): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(roots.reservationsDir, reservationFileName(caseId, model)), 'utf8'));
    return typeof raw?.reserved_at === 'string' ? raw.reserved_at : null;
  } catch {
    return null;
  }
}

/** Never throws for a damaged run-log: it is reported as 'invalid', never as absent or completed. */
export function readRunLog(roots: LedgerRoots, caseId: string, model: EvalModel): RunLogObservation {
  const path = join(roots.runLogsDir, runLogFileName(caseId, model));
  if (!existsSync(path)) return { status: 'absent' };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { status: 'invalid', error: 'not valid JSON' };
  }
  const parsed = parseRunLogRecord(raw, caseId, model);
  return parsed.ok ? { status: 'valid', record: parsed.record } : { status: 'invalid', error: parsed.error };
}

/** Raw bytes of the canonical output, or null if none exists. Hash checks are the caller's job. */
export function readCanonicalOutputBytes(roots: LedgerRoots, caseId: string, model: EvalModel): Buffer | null {
  const path = join(roots.canonicalOutputsDir, outputFileName(caseId, model));
  return existsSync(path) ? readFileSync(path) : null;
}

/** Raw bytes of the preserved rejected output, or null if none exists. Hash checks are the caller's job. */
export function readRejectedOutputBytes(roots: LedgerRoots, caseId: string, model: EvalModel): Buffer | null {
  const path = join(roots.rejectedOutputsDir, rejectedOutputFileName(caseId, model));
  return existsSync(path) ? readFileSync(path) : null;
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

function isEexist(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && (err as { code: unknown }).code === 'EEXIST');
}

/**
 * Atomically claims one of exactly MAX_EXPERIMENT_REQUESTS pre-named budget
 * slots, trying each in order and taking the first not already claimed.
 * Each slot filename can only ever be created once, so the TOTAL number
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

/**
 * Atomically reserves one (case, model) pair, persisting the reservation to
 * disk BEFORE the caller is allowed to send any network request. Safe to
 * call from multiple concurrent processes pointed at the same ledger
 * directory: the exclusive create means two processes racing for the same
 * pair can never both "win". Never refunds; there is deliberately no
 * corresponding "release" or "reset" function anywhere in this module.
 */
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

/** Serializes an output exactly as it is stored, so its SHA-256 is reproducible. */
export function serializeOutput(output: unknown): string {
  return JSON.stringify(output, null, 2) + '\n';
}

/**
 * Writes the authoritative output into the shared ledger (write-once,
 * fsync'd) and returns the SHA-256 of the exact bytes stored. Must happen
 * BEFORE the completing run-log is written.
 */
export async function writeCanonicalOutputOnce(
  roots: LedgerRoots,
  caseId: string,
  model: EvalModel,
  output: unknown
): Promise<{ result: WriteOnceResult; sha256: string }> {
  const bytes = serializeOutput(output);
  const result = await writeOnce(join(roots.canonicalOutputsDir, outputFileName(caseId, model)), bytes);
  return { result, sha256: sha256Hex(bytes) };
}

/**
 * Preserves the model's raw text for an output that failed mechanical
 * validation (write-once, fsync'd) and returns the SHA-256 of the stored
 * bytes. Must happen BEFORE the 'invalid' run-log is written.
 */
export async function writeRejectedOutputOnce(
  roots: LedgerRoots,
  caseId: string,
  model: EvalModel,
  text: string
): Promise<{ result: WriteOnceResult; sha256: string }> {
  const result = await writeOnce(join(roots.rejectedOutputsDir, rejectedOutputFileName(caseId, model)), text);
  return { result, sha256: sha256Hex(text) };
}

/** Writes this checkout's convenience copy of already-verified canonical bytes. Never overwrites. */
export async function writeLocalCopyOnce(roots: LedgerRoots, caseId: string, model: EvalModel, bytes: Buffer): Promise<WriteOnceResult> {
  return writeOnce(join(roots.localOutputsDir, outputFileName(caseId, model)), bytes.toString('utf8'));
}
