/**
 * Real-filesystem tests for the durable Phase 2 request ledger primitives
 * (reservations, budget, layout, write-once files). Runs under
 * vitest.ledger.config.ts (plain Node environment), NOT the main
 * @cloudflare/vitest-pool-workers config — that pool does not implement
 * fs.promises, which this module genuinely needs to prove real atomicity.
 * Pair-state/canonical-output tests: gemini-quality-eval-ledger-state.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import {
  defaultLedgerRoot,
  resolveLedgerRoots,
  ensureLedgerDirs,
  inspectLedgerLayout,
  reserveNext,
  hasReservation,
  readRunLog,
  listReservedPairs,
  writeCanonicalOutputOnce,
  writeRunLogOnce,
  sha256Hex,
  serializeOutput,
  RealLedgerInTestError,
  UnknownPairError,
  LEDGER_FORMAT_FILE,
  type LedgerRoots,
} from './gemini-quality-eval/ledger';
import { getPairState } from './gemini-quality-eval/ledger-state';
import { MAX_EXPERIMENT_REQUESTS } from './gemini-quality-eval/runner';
import {
  MODELS,
  VITE_NODE_BIN,
  WORKERS_DIR,
  childEnv,
  guardRealLedgerUnchanged,
  makeKnownIds,
  makeRunLog,
  snapshotTree,
} from './gemini-quality-eval/test-support';

const LEDGER_MODULE = join(WORKERS_DIR, 'tests', 'gemini-quality-eval', 'ledger.ts');

guardRealLedgerUnchanged();

let tmpDir: string;
/** Stand-in for the user-level ledger directory (the real one is never touched by tests). */
let ledgerRoot: string;
/** Eval root of a simulated first worktree. */
let evalRootA: string;
let roots: LedgerRoots;

function allPairs(n: number): Array<[string, (typeof MODELS)[number]]> {
  const pairs: Array<[string, (typeof MODELS)[number]]> = [];
  for (let i = 0; i < n; i++) for (const m of MODELS) pairs.push([`case-${i}`, m]);
  return pairs;
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'gemini-ledger-test-'));
  ledgerRoot = join(tmpDir, 'user-ledger');
  evalRootA = join(tmpDir, 'worktree-a', 'workers', 'tests', 'gemini-quality-eval');
  roots = resolveLedgerRoots(evalRootA, ledgerRoot);
  await ensureLedgerDirs(roots);
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
  it("a freshly-resolved ledger instance sees a previous instance's reservation", async () => {
    await reserveNext(roots, 'case-0', 'gemini-3.5-flash-lite', makeKnownIds(5));
    // A separate object with no shared in-memory state — what a second
    // process (or the same process after a restart) would see.
    const instance2Roots = resolveLedgerRoots(evalRootA, ledgerRoot);
    expect(hasReservation(instance2Roots, 'case-0', 'gemini-3.5-flash-lite')).toBe(true);
    expect(await reserveNext(instance2Roots, 'case-0', 'gemini-3.5-flash-lite', makeKnownIds(5))).toEqual({
      ok: false,
      reason: 'already_reserved',
    });
  });

  it('treats a reservation with no run-log as ambiguous after a simulated restart, and never auto-repeats it', async () => {
    await reserveNext(roots, 'case-0', 'gemini-3.5-flash-lite', makeKnownIds(5));
    const restarted = resolveLedgerRoots(evalRootA, ledgerRoot);
    expect(getPairState(restarted, 'case-0', 'gemini-3.5-flash-lite')).toBe('ambiguous');
    expect(await reserveNext(restarted, 'case-0', 'gemini-3.5-flash-lite', makeKnownIds(5))).toEqual({
      ok: false,
      reason: 'already_reserved',
    });
  });
});

describe('the 24-request hard cap', () => {
  it('allows exactly 24 reservations and refuses the 25th', async () => {
    // 13 known cases x 2 models = 26 distinct pairs, so the 25th and 26th
    // attempts are refused by the CAP itself, not as unknown or duplicate pairs.
    const known = makeKnownIds(13);
    const results = [];
    for (const [caseId, model] of allPairs(13)) results.push(await reserveNext(roots, caseId, model, known));
    expect(results.filter((r) => r.ok)).toHaveLength(MAX_EXPERIMENT_REQUESTS);
    expect(results.filter((r) => !r.ok && r.reason === 'cap_reached')).toHaveLength(2);
    expect(listReservedPairs(roots)).toHaveLength(MAX_EXPERIMENT_REQUESTS);
  });
});

describe('the ledger is shared, and pair-keyed, across worktrees / eval roots on the same machine', () => {
  it('a different worktree sees the same reservations, the same outcomes and the same exhausted budget', async () => {
    const known = makeKnownIds(13);
    expect((await reserveNext(roots, 'case-0', 'gemini-3.5-flash-lite', known)).ok).toBe(true);
    await writeRunLogOnce(roots, 'case-0', 'gemini-3.5-flash-lite', makeRunLog('case-0', 'gemini-3.5-flash-lite', 'failed'));
    expect((await reserveNext(roots, 'case-0', 'gemini-3.6-flash', known)).ok).toBe(true); // left ambiguous

    const evalRootB = join(tmpDir, 'worktree-b', 'workers', 'tests', 'gemini-quality-eval');
    const rootsB = resolveLedgerRoots(evalRootB, ledgerRoot);
    await ensureLedgerDirs(rootsB);
    expect(rootsB.localOutputsDir).not.toBe(roots.localOutputsDir); // only convenience copies are per-checkout
    for (const key of ['budgetDir', 'reservationsDir', 'runLogsDir', 'canonicalOutputsDir'] as const) {
      expect(rootsB[key]).toBe(roots[key]);
    }

    expect(getPairState(rootsB, 'case-0', 'gemini-3.5-flash-lite')).toBe('failed');
    expect(getPairState(rootsB, 'case-0', 'gemini-3.6-flash')).toBe('ambiguous');
    expect(await reserveNext(rootsB, 'case-0', 'gemini-3.5-flash-lite', known)).toEqual({ ok: false, reason: 'already_reserved' });
    expect(await reserveNext(rootsB, 'case-0', 'gemini-3.6-flash', known)).toEqual({ ok: false, reason: 'already_reserved' });

    let wonInB = 0;
    for (const [caseId, m] of allPairs(13).slice(2)) if ((await reserveNext(rootsB, caseId, m, known)).ok) wonInB++;
    expect(wonInB).toBe(MAX_EXPERIMENT_REQUESTS - 2);
    expect(listReservedPairs(roots)).toHaveLength(MAX_EXPERIMENT_REQUESTS);
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

describe('ledger layout marker and legacy layouts', () => {
  it('a new ledger carries a format marker and has no experiment namespace', () => {
    expect(readdirSync(ledgerRoot).sort()).toEqual([LEDGER_FORMAT_FILE, 'outputs', 'rejected-outputs', 'request-budget', 'reservations', 'run-logs']);
    expect(inspectLedgerLayout(roots)).toEqual([]);
  });

  it('refuses the legacy per-experiment layout without changing a single file', async () => {
    const legacyRoot = join(tmpDir, 'legacy-ledger');
    mkdirSync(join(legacyRoot, 'experiments', 'old-exp', 'reservations'), { recursive: true });
    mkdirSync(join(legacyRoot, 'request-budget'), { recursive: true });
    writeFileSync(join(legacyRoot, 'experiments', 'old-exp', 'reservations', 'case-0.gemini-3.6-flash.reserved'), '{}');
    writeFileSync(join(legacyRoot, 'request-budget', '_slot-00.claim'), '{}');
    const before = snapshotTree(legacyRoot);
    const legacy = resolveLedgerRoots(evalRootA, legacyRoot);

    const problems = inspectLedgerLayout(legacy);
    expect(problems.some((p) => /legacy per-experiment ledger layout/.test(p))).toBe(true);
    expect(problems.some((p) => /no LEDGER_FORMAT marker/.test(p))).toBe(true);
    await expect(ensureLedgerDirs(legacy)).rejects.toThrow(/legacy per-experiment/);
    expect(snapshotTree(legacyRoot)).toEqual(before); // no marker stamped, nothing reset or deleted
  });

  it('refuses an unrecognized marker or unexpected entries', () => {
    writeFileSync(join(ledgerRoot, 'stray-file'), 'x');
    expect(inspectLedgerLayout(roots).some((p) => /Unexpected entry/.test(p))).toBe(true);
    const other = join(tmpDir, 'other-ledger');
    mkdirSync(other);
    writeFileSync(join(other, LEDGER_FORMAT_FILE), '{"format":"something-else","version":9}\n');
    expect(inspectLedgerLayout(resolveLedgerRoots(evalRootA, other)).some((p) => /does not identify a format-2 ledger/.test(p))).toBe(true);
  });
});

describe('test functions cannot claim the real user-level ledger', () => {
  it('resolveLedgerRoots refuses the real ledger under Vitest and requires an explicit root', () => {
    expect(() => resolveLedgerRoots(evalRootA, defaultLedgerRoot())).toThrow(RealLedgerInTestError);
    expect(() => resolveLedgerRoots(evalRootA, join(defaultLedgerRoot(), '.'))).toThrow(RealLedgerInTestError);
    expect(() => resolveLedgerRoots(evalRootA, '')).toThrow(/explicit ledger root/);
    // @ts-expect-error — deliberately omitting the required ledger root
    expect(() => resolveLedgerRoots(evalRootA)).toThrow(/explicit ledger root/);
  });
});

describe('concurrency safety (in-process)', () => {
  it('when two callers race for the SAME pair, exactly one wins', async () => {
    const known = makeKnownIds(5);
    const outcomes = await Promise.all([
      reserveNext(roots, 'case-0', 'gemini-3.5-flash-lite', known),
      reserveNext(roots, 'case-0', 'gemini-3.5-flash-lite', known),
    ]);
    expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
    expect(outcomes.filter((r) => !r.ok && r.reason === 'already_reserved')).toHaveLength(1);
    expect(listReservedPairs(roots)).toHaveLength(1);
  });

  it('concurrent reservations across many distinct pairs never exceed the hard cap', async () => {
    const known = makeKnownIds(13);
    const results = await Promise.all(allPairs(13).map(([caseId, model]) => reserveNext(roots, caseId, model, known)));
    const succeeded = results.filter((r) => r.ok);
    expect(succeeded.length).toBeLessThanOrEqual(MAX_EXPERIMENT_REQUESTS);
    for (const r of results.filter((x) => !x.ok)) expect((r as { reason: string }).reason).toBe('cap_reached');
    expect(listReservedPairs(roots).length).toBe(succeeded.length);
  });
});

describe('multi-process concurrency (real child processes, shared ledger directory)', () => {
  it('separate OS processes in separate worktrees racing over 26 pairs never exceed 24 reservations or double-reserve a pair', async () => {
    const PROCESSES = 4;
    const helperPath = join(tmpDir, 'reserve-worker.ts');
    // Each worker reserves all 26 pairs in a different rotated order, so the
    // processes race both for the same pairs and for budget slots.
    writeFileSync(
      helperPath,
      `import { resolveLedgerRoots, ensureLedgerDirs, reserveNext } from ${JSON.stringify(LEDGER_MODULE)};
const [evalRoot, workerIndex, ledgerRoot] = process.argv.slice(2);
const roots = resolveLedgerRoots(evalRoot, ledgerRoot);
await ensureLedgerDirs(roots);
const known = new Set(Array.from({ length: 13 }, (_, i) => 'case-' + i));
const pairs = [];
for (let i = 0; i < 13; i++) for (const m of ['gemini-3.5-flash-lite', 'gemini-3.6-flash']) pairs.push(['case-' + i, m]);
const offset = Number(workerIndex) * 7;
const results = [];
for (const [caseId, model] of pairs.map((_, i) => pairs[(i + offset) % pairs.length])) {
  const r = await reserveNext(roots, caseId, model, known);
  results.push({ pair: caseId + '.' + model, ok: r.ok, reason: r.ok ? null : r.reason });
}
console.log('RESULT ' + JSON.stringify(results));
`
    );

    const runWorker = (index: number) =>
      new Promise<Array<{ pair: string; ok: boolean; reason: string | null }>>((resolvePromise, reject) => {
        const workerEvalRoot = join(tmpDir, `worktree-${index}`, 'eval'); // distinct checkout per process
        const child = spawn(VITE_NODE_BIN, [helperPath, '--', workerEvalRoot, String(index), ledgerRoot], {
          cwd: WORKERS_DIR,
          env: childEnv(),
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

    const all = (await Promise.all(Array.from({ length: PROCESSES }, (_, i) => runWorker(i)))).flat();
    const wins = all.filter((r) => r.ok);
    expect(all).toHaveLength(PROCESSES * 26);
    expect(wins.length).toBeLessThanOrEqual(MAX_EXPERIMENT_REQUESTS);
    expect(new Set(wins.map((w) => w.pair)).size).toBe(wins.length); // no pair won twice
    for (const r of all.filter((x) => !x.ok)) expect(['already_reserved', 'cap_reached']).toContain(r.reason);
    expect(listReservedPairs(roots)).toHaveLength(wins.length);
    expect(readdirSync(roots.budgetDir).filter((f) => f.endsWith('.claim'))).toHaveLength(MAX_EXPERIMENT_REQUESTS);
  }, 60_000);
});

describe('canonical output and run-log write-once safety', () => {
  it('writes a canonical output once, returns the SHA-256 of the stored bytes, and refuses to overwrite it', async () => {
    const first = await writeCanonicalOutputOnce(roots, 'case-0', 'gemini-3.5-flash-lite', { summary: 'first' });
    expect(first.result).toBe('written');
    const path = join(roots.canonicalOutputsDir, 'case-0.gemini-3.5-flash-lite.json');
    expect(first.sha256).toBe(sha256Hex(readFileSync(path)));
    expect(readFileSync(path, 'utf8')).toBe(serializeOutput({ summary: 'first' }));
    const second = await writeCanonicalOutputOnce(roots, 'case-0', 'gemini-3.5-flash-lite', { summary: 'second' });
    expect(second.result).toBe('already_exists');
    expect(JSON.parse(readFileSync(path, 'utf8')).summary).toBe('first');
  });

  it('writes a run-log once and refuses to overwrite it', async () => {
    expect(await writeRunLogOnce(roots, 'case-0', 'gemini-3.5-flash-lite', makeRunLog('case-0', 'gemini-3.5-flash-lite', 'failed'))).toBe('written');
    const again = makeRunLog('case-0', 'gemini-3.5-flash-lite', 'completed', 'a'.repeat(64));
    expect(await writeRunLogOnce(roots, 'case-0', 'gemini-3.5-flash-lite', again)).toBe('already_exists');
    const stored = readRunLog(roots, 'case-0', 'gemini-3.5-flash-lite');
    expect(stored.status === 'valid' && stored.record.outcome).toBe('failed'); // the original, not the overwrite
  });

  it('a failed request consumes its reservation and is reported distinctly from not-attempted', async () => {
    const known = makeKnownIds(5);
    await reserveNext(roots, 'case-0', 'gemini-3.5-flash-lite', known);
    await writeRunLogOnce(roots, 'case-0', 'gemini-3.5-flash-lite', makeRunLog('case-0', 'gemini-3.5-flash-lite', 'failed'));
    expect(getPairState(roots, 'case-0', 'gemini-3.5-flash-lite')).toBe('failed');
    expect(await reserveNext(roots, 'case-0', 'gemini-3.5-flash-lite', known)).toEqual({ ok: false, reason: 'already_reserved' });
    expect(getPairState(roots, 'case-1', 'gemini-3.5-flash-lite')).toBe('not_attempted');
  });
});
