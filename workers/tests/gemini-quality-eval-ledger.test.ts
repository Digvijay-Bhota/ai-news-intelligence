/**
 * Real-filesystem tests for the durable Phase 2 request ledger. Runs under
 * vitest.ledger.config.ts (plain Node environment), NOT the main
 * @cloudflare/vitest-pool-workers config — that pool does not implement
 * fs.promises, which this module genuinely needs to prove real atomicity.
 * See ledger.ts's module doc for why.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultLedgerRoot,
  resolveLedgerRoots,
  ensureLedgerDirs,
  reserveNext,
  hasReservation,
  readRunLog,
  hasOutput,
  getPairState,
  listReservedPairs,
  writeOutputOnce,
  writeRunLogOnce,
  checkLedgerConsistency,
  UnknownPairError,
  type LedgerRoots,
} from './gemini-quality-eval/ledger';
import { MAX_EXPERIMENT_REQUESTS, type RunLogRecord } from './gemini-quality-eval/runner';

const EXPERIMENT_ID = 'test-experiment';
const WORKERS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER_MODULE = join(WORKERS_DIR, 'tests', 'gemini-quality-eval', 'ledger.ts');
const VITE_NODE_BIN = join(WORKERS_DIR, 'node_modules', '.bin', 'vite-node');

function makeKnownIds(n: number): Set<string> {
  return new Set(Array.from({ length: n }, (_, i) => `case-${i}`));
}

function makeRunLog(caseId: string, model: 'gemini-3.5-flash-lite' | 'gemini-3.6-flash', outcome: 'completed' | 'failed'): RunLogRecord {
  return {
    experiment_id: EXPERIMENT_ID,
    case_id: caseId,
    task: 'event_brief',
    model,
    reserved_at: new Date().toISOString(),
    recorded_at: new Date().toISOString(),
    outcome,
    response_meta: null,
    error_classification: outcome === 'failed' ? { classification: 'unknown', httpStatus: null, apiStatus: null, quotaIds: [], retryAfterSeconds: null } : null,
    error_message: outcome === 'failed' ? 'simulated failure' : null,
    mechanical_validation: { ran: outcome === 'completed', valid: outcome === 'completed' ? true : null, errors: [] },
  };
}

let tmpDir: string;
/** Stand-in for the user-level ledger directory (the real one is never touched by tests). */
let ledgerRoot: string;
/** Eval root of a simulated first worktree. */
let evalRootA: string;
let roots: LedgerRoots;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'gemini-ledger-test-'));
  ledgerRoot = join(tmpDir, 'user-ledger');
  evalRootA = join(tmpDir, 'worktree-a', 'workers', 'tests', 'gemini-quality-eval');
  roots = resolveLedgerRoots(evalRootA, EXPERIMENT_ID, ledgerRoot);
  ensureLedgerDirs(roots);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('reserveNext — single pair', () => {
  it('reserves a fresh pair and persists both the reservation and its budget slot to disk', async () => {
    const result = await reserveNext(roots, 'case-0', 'gemini-3.5-flash-lite', makeKnownIds(5));
    expect(result.ok).toBe(true);
    expect(hasReservation(roots, 'case-0', 'gemini-3.5-flash-lite')).toBe(true);
    const onDisk = JSON.parse(readFileSync(join(roots.reservationsDir, 'case-0.gemini-3.5-flash-lite.reserved'), 'utf8'));
    if (result.ok) expect(onDisk.reserved_at).toBe(result.reservedAt);
    expect(readdirSync(roots.budgetDir)).toEqual(['_slot-00.claim']);
  });

  it('refuses a second reservation of the same pair', async () => {
    await reserveNext(roots, 'case-0', 'gemini-3.5-flash-lite', makeKnownIds(5));
    const second = await reserveNext(roots, 'case-0', 'gemini-3.5-flash-lite', makeKnownIds(5));
    expect(second).toEqual({ ok: false, reason: 'already_reserved' });
  });

  it('rejects an unknown case ID before touching the filesystem', async () => {
    await expect(reserveNext(roots, 'not-a-real-case', 'gemini-3.5-flash-lite', makeKnownIds(5))).rejects.toThrow(UnknownPairError);
    expect(listReservedPairs(roots)).toHaveLength(0);
  });

  it('rejects an unsupported model', async () => {
    await expect(reserveNext(roots, 'case-0', 'gpt-4', makeKnownIds(5))).rejects.toThrow(UnknownPairError);
  });
});

describe('cross-process / restart persistence', () => {
  it('a freshly-resolved ledger instance sees a previous instance\'s reservation', async () => {
    // "Instance 1" reserves a pair.
    await reserveNext(roots, 'case-0', 'gemini-3.5-flash-lite', makeKnownIds(5));

    // "Instance 2" is a completely separate object, pointed at the same
    // directory, with no shared in-memory state — this is what a second
    // process (or the same process after a restart) would see.
    const instance2Roots = resolveLedgerRoots(evalRootA, EXPERIMENT_ID, ledgerRoot);
    expect(hasReservation(instance2Roots, 'case-0', 'gemini-3.5-flash-lite')).toBe(true);

    const secondAttempt = await reserveNext(instance2Roots, 'case-0', 'gemini-3.5-flash-lite', makeKnownIds(5));
    expect(secondAttempt).toEqual({ ok: false, reason: 'already_reserved' });
  });

  it('treats a reservation with no run-log as ambiguous after a simulated restart, and never auto-repeats it', async () => {
    // Simulates a crash: a reservation was persisted, but the process died
    // before writing a run-log.
    await reserveNext(roots, 'case-0', 'gemini-3.5-flash-lite', makeKnownIds(5));

    const restarted = resolveLedgerRoots(evalRootA, EXPERIMENT_ID, ledgerRoot);
    expect(getPairState(restarted, 'case-0', 'gemini-3.5-flash-lite')).toBe('ambiguous');

    // A new run must not silently repeat the "ambiguous" pair: attempting to
    // reserve it again is refused, exactly like any other already-reserved pair.
    const retry = await reserveNext(restarted, 'case-0', 'gemini-3.5-flash-lite', makeKnownIds(5));
    expect(retry).toEqual({ ok: false, reason: 'already_reserved' });
  });
});

describe('the 24-request hard cap', () => {
  it('allows exactly 24 reservations and refuses the 25th', async () => {
    // 13 known cases x 2 models = 26 possible distinct pairs, so the 25th
    // and 26th attempts are refused by the CAP itself, not because they are
    // unknown or duplicate pairs.
    const known = makeKnownIds(13);
    const models: Array<'gemini-3.5-flash-lite' | 'gemini-3.6-flash'> = ['gemini-3.5-flash-lite', 'gemini-3.6-flash'];
    const pairs: Array<[string, typeof models[number]]> = [];
    for (let i = 0; i < 13; i++) for (const m of models) pairs.push([`case-${i}`, m]);
    expect(pairs).toHaveLength(26);

    const results = [];
    for (const [caseId, model] of pairs) {
      results.push(await reserveNext(roots, caseId, model, known));
    }

    const succeeded = results.filter((r) => r.ok);
    const capRefused = results.filter((r) => !r.ok && r.reason === 'cap_reached');
    expect(succeeded).toHaveLength(MAX_EXPERIMENT_REQUESTS);
    expect(capRefused).toHaveLength(2);
    expect(listReservedPairs(roots)).toHaveLength(MAX_EXPERIMENT_REQUESTS);
  });
});

describe('the cap is experiment-wide, not per experiment ID', () => {
  it('a restarted process using a NEW experiment ID cannot obtain a fresh 24-request budget', async () => {
    const known = makeKnownIds(13);
    for (let i = 0; i < 12; i++) {
      for (const m of ['gemini-3.5-flash-lite', 'gemini-3.6-flash'] as const) {
        expect((await reserveNext(roots, `case-${i}`, m, known)).ok).toBe(true);
      }
    }

    // Fresh roots object, different experiment ID, no shared in-memory state.
    const otherRoots = resolveLedgerRoots(evalRootA, 'renamed-experiment', ledgerRoot);
    ensureLedgerDirs(otherRoots);
    const result = await reserveNext(otherRoots, 'case-12', 'gemini-3.5-flash-lite', known);
    expect(result).toEqual({ ok: false, reason: 'cap_reached', count: MAX_EXPERIMENT_REQUESTS });
    expect(listReservedPairs(otherRoots)).toHaveLength(0);
    expect(readdirSync(roots.budgetDir)).toHaveLength(MAX_EXPERIMENT_REQUESTS);
  });
});

describe('the ledger is shared across worktrees / eval roots on the same machine', () => {
  it('a different worktree (different eval root) sees the same reservations and the same exhausted budget', async () => {
    const known = makeKnownIds(13);
    // Worktree A attempts one pair and it fails; then uses the rest of the budget.
    expect((await reserveNext(roots, 'case-0', 'gemini-3.5-flash-lite', known)).ok).toBe(true);
    await writeRunLogOnce(roots, 'case-0', 'gemini-3.5-flash-lite', makeRunLog('case-0', 'gemini-3.5-flash-lite', 'failed'));
    expect((await reserveNext(roots, 'case-0', 'gemini-3.6-flash', known)).ok).toBe(true); // left ambiguous

    // Worktree B: a different checkout path, same experiment ID, same user ledger.
    const evalRootB = join(tmpDir, 'worktree-b', 'workers', 'tests', 'gemini-quality-eval');
    const rootsB = resolveLedgerRoots(evalRootB, EXPERIMENT_ID, ledgerRoot);
    ensureLedgerDirs(rootsB);
    expect(rootsB.outputsDir).not.toBe(roots.outputsDir); // outputs stay per-checkout
    expect(rootsB.budgetDir).toBe(roots.budgetDir);

    // The failed and the ambiguous pair are NOT fresh again in worktree B — no refund, no re-send.
    expect(getPairState(rootsB, 'case-0', 'gemini-3.5-flash-lite')).toBe('failed');
    expect(getPairState(rootsB, 'case-0', 'gemini-3.6-flash')).toBe('ambiguous');
    expect(await reserveNext(rootsB, 'case-0', 'gemini-3.5-flash-lite', known)).toEqual({ ok: false, reason: 'already_reserved' });
    expect(await reserveNext(rootsB, 'case-0', 'gemini-3.6-flash', known)).toEqual({ ok: false, reason: 'already_reserved' });

    // Worktree B spends the remaining 22 slots; then neither checkout can reserve more.
    let wonInB = 0;
    for (let i = 1; i < 13; i++) {
      for (const m of ['gemini-3.5-flash-lite', 'gemini-3.6-flash'] as const) {
        if ((await reserveNext(rootsB, `case-${i}`, m, known)).ok) wonInB++;
      }
    }
    expect(wonInB).toBe(MAX_EXPERIMENT_REQUESTS - 2);
    expect(listReservedPairs(roots)).toHaveLength(MAX_EXPERIMENT_REQUESTS);
    const evalRootC = join(tmpDir, 'clone-c', 'workers', 'tests', 'gemini-quality-eval');
    const rootsC = resolveLedgerRoots(evalRootC, 'yet-another-experiment', ledgerRoot);
    ensureLedgerDirs(rootsC);
    expect(await reserveNext(rootsC, 'case-12', 'gemini-3.6-flash', known)).toEqual({
      ok: false,
      reason: 'cap_reached',
      count: MAX_EXPERIMENT_REQUESTS,
    });
  });

  it('the default ledger location is fixed per OS user and ignores $HOME and the current directory', () => {
    const expected = join(userInfo().homedir, '.local', 'state', 'ai-news-intelligence', 'gemini-quality-eval');
    const originalHome = process.env.HOME;
    const originalCwd = process.cwd();
    try {
      process.env.HOME = tmpDir;
      process.chdir(tmpDir);
      expect(defaultLedgerRoot()).toBe(expected);
    } finally {
      process.chdir(originalCwd);
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
    expect(defaultLedgerRoot()).toBe(expected);
  });
});

describe('concurrency safety', () => {
  it('when two callers race for the SAME pair, exactly one wins', async () => {
    const known = makeKnownIds(5);
    const [a, b] = await Promise.all([
      reserveNext(roots, 'case-0', 'gemini-3.5-flash-lite', known),
      reserveNext(roots, 'case-0', 'gemini-3.5-flash-lite', known),
    ]);
    const outcomes = [a, b];
    expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
    expect(outcomes.filter((r) => !r.ok && r.reason === 'already_reserved')).toHaveLength(1);
    expect(listReservedPairs(roots)).toHaveLength(1);
  });

  it('concurrent reservations across many distinct pairs never exceed the hard cap', async () => {
    // 13 known cases x 2 models = 26 distinct pairs, all reserved CONCURRENTLY
    // (not sequentially) — this is the scenario a naive read-count-then-write
    // check would get wrong, since many callers can observe "room left"
    // before any of their writes land.
    const known = makeKnownIds(13);
    const models: Array<'gemini-3.5-flash-lite' | 'gemini-3.6-flash'> = ['gemini-3.5-flash-lite', 'gemini-3.6-flash'];
    const pairs: Array<[string, typeof models[number]]> = [];
    for (let i = 0; i < 13; i++) for (const m of models) pairs.push([`case-${i}`, m]);

    const results = await Promise.all(pairs.map(([caseId, model]) => reserveNext(roots, caseId, model, known)));
    const succeeded = results.filter((r) => r.ok);
    expect(succeeded.length).toBeLessThanOrEqual(MAX_EXPERIMENT_REQUESTS);
    // Every distinct pair is independent (no duplicate-pair races here), so
    // nothing should be refused for 'already_reserved' — only the cap, if hit.
    const refused = results.filter((r) => !r.ok);
    for (const r of refused) {
      expect((r as { reason: string }).reason).toBe('cap_reached');
    }
    expect(listReservedPairs(roots).length).toBe(succeeded.length);
    expect(listReservedPairs(roots).length).toBeLessThanOrEqual(MAX_EXPERIMENT_REQUESTS);
  });
});

describe('multi-process concurrency (real child processes, shared ledger directory)', () => {
  it('separate OS processes in separate worktrees racing over 26 pairs never exceed 24 reservations or double-reserve a pair', async () => {
    const PROCESSES = 4;
    const helperPath = join(tmpDir, 'reserve-worker.ts');
    // Each worker reserves all 26 pairs (13 cases x 2 models) in a different
    // rotated order, so the processes race both for the same pairs and for
    // budget slots on different pairs.
    writeFileSync(
      helperPath,
      `import { resolveLedgerRoots, ensureLedgerDirs, reserveNext } from ${JSON.stringify(LEDGER_MODULE)};
const [evalRoot, experimentId, workerIndex, ledgerRoot] = process.argv.slice(2);
const roots = resolveLedgerRoots(evalRoot, experimentId, ledgerRoot);
ensureLedgerDirs(roots);
const known = new Set(Array.from({ length: 13 }, (_, i) => 'case-' + i));
const pairs = [];
for (let i = 0; i < 13; i++) for (const m of ['gemini-3.5-flash-lite', 'gemini-3.6-flash']) pairs.push(['case-' + i, m]);
const offset = Number(workerIndex) * 7;
const ordered = pairs.map((_, i) => pairs[(i + offset) % pairs.length]);
const results = [];
for (const [caseId, model] of ordered) {
  const r = await reserveNext(roots, caseId, model, known);
  results.push({ pair: caseId + '.' + model, ok: r.ok, reason: r.ok ? null : r.reason });
}
console.log('RESULT ' + JSON.stringify(results));
`
    );

    const env = { ...process.env };
    delete env.VITEST;
    delete env.GEMINI_API_KEY;
    delete env.GEMINI_QUALITY_EVAL_API_KEY;

    const runWorker = (index: number) =>
      new Promise<Array<{ pair: string; ok: boolean; reason: string | null }>>((resolvePromise, reject) => {
        // A distinct eval root per process simulates separate worktrees/clones.
        const workerEvalRoot = join(tmpDir, `worktree-${index}`, 'eval');
        const child = spawn(VITE_NODE_BIN, [helperPath, '--', workerEvalRoot, EXPERIMENT_ID, String(index), ledgerRoot], {
          cwd: WORKERS_DIR,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('error', reject);
        child.on('close', (code) => {
          const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
          if (code !== 0 || !line) return reject(new Error(`worker ${index} exited ${code}: ${stderr}`));
          resolvePromise(JSON.parse(line.slice('RESULT '.length)));
        });
      });

    const perWorker = await Promise.all(Array.from({ length: PROCESSES }, (_, i) => runWorker(i)));
    const all = perWorker.flat();
    const wins = all.filter((r) => r.ok);

    expect(all).toHaveLength(PROCESSES * 26);
    // Never more than the cap, across all processes combined.
    expect(wins.length).toBeLessThanOrEqual(MAX_EXPERIMENT_REQUESTS);
    // No pair was won by two processes.
    expect(new Set(wins.map((w) => w.pair)).size).toBe(wins.length);
    // Every refusal is one of the two expected, safe reasons.
    for (const r of all.filter((x) => !x.ok)) expect(['already_reserved', 'cap_reached']).toContain(r.reason);
    // What is on disk agrees with what the processes reported.
    expect(listReservedPairs(roots)).toHaveLength(wins.length);
    // 26 pairs > 24 slots, so every slot ends up claimed — and never more.
    const slots = readdirSync(roots.budgetDir).filter((f) => f.endsWith('.claim'));
    expect(slots).toHaveLength(MAX_EXPERIMENT_REQUESTS);
  }, 60_000);
});

describe('output and run-log write-once safety', () => {
  it('writes an output once and refuses to overwrite it', async () => {
    const first = await writeOutputOnce(roots, 'case-0', 'gemini-3.5-flash-lite', { summary: 'first' });
    expect(first).toBe('written');
    const second = await writeOutputOnce(roots, 'case-0', 'gemini-3.5-flash-lite', { summary: 'second' });
    expect(second).toBe('already_exists');
    const onDisk = JSON.parse(readFileSync(join(roots.outputsDir, 'case-0.gemini-3.5-flash-lite.json'), 'utf8'));
    expect(onDisk.summary).toBe('first');
  });

  it('writes a run-log once and refuses to overwrite it', async () => {
    const record = makeRunLog('case-0', 'gemini-3.5-flash-lite', 'failed');
    const first = await writeRunLogOnce(roots, 'case-0', 'gemini-3.5-flash-lite', record);
    expect(first).toBe('written');
    const second = await writeRunLogOnce(roots, 'case-0', 'gemini-3.5-flash-lite', makeRunLog('case-0', 'gemini-3.5-flash-lite', 'completed'));
    expect(second).toBe('already_exists');
    const stored = readRunLog(roots, 'case-0', 'gemini-3.5-flash-lite');
    expect(stored?.outcome).toBe('failed'); // the original, not the attempted overwrite
  });

  it('a failed request consumes its reservation and is reported distinctly from completed/ambiguous/not-attempted', async () => {
    const known = makeKnownIds(5);
    await reserveNext(roots, 'case-0', 'gemini-3.5-flash-lite', known);
    await writeRunLogOnce(roots, 'case-0', 'gemini-3.5-flash-lite', makeRunLog('case-0', 'gemini-3.5-flash-lite', 'failed'));

    expect(getPairState(roots, 'case-0', 'gemini-3.5-flash-lite')).toBe('failed');
    // Retrying the same pair after a failure is refused — no automatic retry.
    const retry = await reserveNext(roots, 'case-0', 'gemini-3.5-flash-lite', known);
    expect(retry).toEqual({ ok: false, reason: 'already_reserved' });

    // Distinguishable from a pair that was never touched at all.
    expect(getPairState(roots, 'case-1', 'gemini-3.5-flash-lite')).toBe('not_attempted');
  });
});

describe('checkLedgerConsistency', () => {
  it('reports no problems for a clean ledger', () => {
    const problems = checkLedgerConsistency(roots, [{ caseId: 'case-0', model: 'gemini-3.5-flash-lite' }]);
    expect(problems).toHaveLength(0);
  });

  it('flags an output that exists without a matching completed run-log, and never deletes or fixes it', async () => {
    await writeOutputOnce(roots, 'case-0', 'gemini-3.5-flash-lite', { summary: 'orphaned' });
    const problems = checkLedgerConsistency(roots, [{ caseId: 'case-0', model: 'gemini-3.5-flash-lite' }]);
    expect(problems).toHaveLength(1);
    expect(problems[0].problem).toMatch(/without a matching completed run-log/);
    // The orphaned output must still be there — nothing was reset.
    expect(hasOutput(roots, 'case-0', 'gemini-3.5-flash-lite')).toBe(true);
  });

  it('flags a run-log that claims completed but has no output file', async () => {
    const known = makeKnownIds(5);
    await reserveNext(roots, 'case-0', 'gemini-3.5-flash-lite', known);
    await writeRunLogOnce(roots, 'case-0', 'gemini-3.5-flash-lite', makeRunLog('case-0', 'gemini-3.5-flash-lite', 'completed'));
    const problems = checkLedgerConsistency(roots, [{ caseId: 'case-0', model: 'gemini-3.5-flash-lite' }]);
    expect(problems.some((p) => p.problem.includes('no output file exists'))).toBe(true);
  });
});
