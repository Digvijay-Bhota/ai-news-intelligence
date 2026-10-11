/**
 * End-to-end tests for the Phase 2 comparison-runner orchestration (main())
 * against real, temporary ledger directories. Runs under
 * vitest.ledger.config.ts (plain Node) because it needs real fs.
 *
 * global.fetch is ALWAYS mocked here — this file never calls the real
 * Gemini API. It exercises the REAL production generator functions and the
 * REAL ledger, with only the network boundary replaced. Import-safety,
 * real-ledger isolation, redaction and multi-process tests live in
 * gemini-quality-comparison-runner-isolation.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, runCli } from '../scripts/gemini-quality-comparison-runner';
import { ensureLedgerDirs, readRunLog, reserveNext, resolveLedgerRoots, sha256Hex, type LedgerRoots } from './gemini-quality-eval/ledger';
import { getPairState } from './gemini-quality-eval/ledger-state';
import {
  VALID_BRIEF_JSON,
  errorResponse,
  geminiResponse,
  guardRealLedgerUnchanged,
  snapshotTree,
  writeCaseFixtures,
} from './gemini-quality-eval/test-support';

guardRealLedgerUnchanged();

const LITE = 'gemini-3.5-flash-lite' as const;
const FLASH = 'gemini-3.6-flash' as const;

let testRoot: string;
/** Eval root of the simulated primary worktree. */
let evalRoot: string;
/** Stand-in for the user-level ledger, shared by every simulated worktree in a test. */
let ledgerRoot: string;
let roots: LedgerRoots;
let originalFetch: typeof fetch;
let originalEnv: NodeJS.ProcessEnv;

function run(args: string[]): Promise<number> {
  return main(args, ledgerRoot);
}

/** Runs fn with console output captured (and silenced). */
async function captured<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  const lines: string[] = [];
  const push = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  const logSpy = vi.spyOn(console, 'log').mockImplementation(push);
  const errSpy = vi.spyOn(console, 'error').mockImplementation(push);
  try {
    return { result: await fn(), out: lines.join('\n') };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}

/** Lite succeeds, 3.6-flash fails with a 500; counts calls. */
function mixedFetch() {
  return vi.fn().mockImplementation((url: string) =>
    Promise.resolve(String(url).includes(FLASH) ? errorResponse() : geminiResponse(VALID_BRIEF_JSON))
  );
}

/** A grounded-looking brief that fails real validation (why_it_matters too short). */
const SCHEMA_INVALID_TEXT = JSON.stringify({ ...JSON.parse(VALID_BRIEF_JSON), why_it_matters: 'x' });
const PROSE_TEXT = 'The council approved the expansion. (Answered in prose, not JSON.)';

/** Lite returns schema-invalid JSON, 3.6-flash returns prose (unparseable). */
function invalidOutputFetch() {
  return vi.fn().mockImplementation((url: string) =>
    Promise.resolve(geminiResponse(String(url).includes(FLASH) ? PROSE_TEXT : SCHEMA_INVALID_TEXT))
  );
}

function useFetch(spy: ReturnType<typeof vi.fn>): void {
  global.fetch = spy as unknown as typeof fetch;
}

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'gemini-runner-cli-test-'));
  evalRoot = join(testRoot, 'worktree-a', 'eval');
  ledgerRoot = join(testRoot, 'user-ledger');
  writeCaseFixtures(evalRoot);
  roots = resolveLedgerRoots(evalRoot, ledgerRoot);
  originalFetch = global.fetch;
  originalEnv = { ...process.env };
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
  global.fetch = originalFetch;
  process.env = originalEnv;
});

describe('dry-run', () => {
  it('is the default: zero fetch calls, no API key, nothing written', async () => {
    delete process.env.GEMINI_QUALITY_EVAL_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const fetchSpy = vi.fn(() => {
      throw new Error('fetch must never be called during a dry run');
    });
    useFetch(fetchSpy);

    const { result, out } = await captured(() => run(['--eval-root', evalRoot]));
    expect(result).toBe(0);
    expect(out).toContain('DRY RUN');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(ledgerRoot)).toBe(false);
    expect(existsSync(roots.localOutputsDir)).toBe(false);
  });
});

describe('experiment IDs no longer exist', () => {
  it('rejects --experiment-id as a usage error before any ledger access or request', async () => {
    process.env.GEMINI_QUALITY_EVAL_API_KEY = 'eval-key';
    const fetchSpy = vi.fn();
    useFetch(fetchSpy);
    await expect(run(['--eval-root', evalRoot, '--execute', '--experiment-id', 'renamed'])).rejects.toThrow(/experiment-id/);
    const { result } = await captured(() => runCli(['--eval-root', evalRoot, '--execute', '--experiment-id', 'renamed'], ledgerRoot));
    expect(result).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(ledgerRoot)).toBe(false);
  });
});

describe('--execute without a dedicated key', () => {
  it('refuses to run even if the production GEMINI_API_KEY is set, and never calls fetch or writes', async () => {
    delete process.env.GEMINI_QUALITY_EVAL_API_KEY;
    process.env.GEMINI_API_KEY = 'prod-key-should-never-be-used';
    const fetchSpy = vi.fn();
    useFetch(fetchSpy);
    await expect(captured(() => run(['--eval-root', evalRoot, '--execute']))).rejects.toThrow(/GEMINI_QUALITY_EVAL_API_KEY/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(ledgerRoot)).toBe(false);
  });
});

describe('--execute', () => {
  it('saves a canonical output whose SHA-256 is in the run-log, then a matching local copy', async () => {
    process.env.GEMINI_QUALITY_EVAL_API_KEY = 'eval-key';
    const fetchSpy = vi.fn().mockImplementation(() => Promise.resolve(geminiResponse(VALID_BRIEF_JSON)));
    useFetch(fetchSpy);

    const { result } = await captured(() => run(['--eval-root', evalRoot, '--execute']));
    expect(result).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // one per model, no retries

    for (const model of [LITE, FLASH]) {
      const canonical = readFileSync(join(roots.canonicalOutputsDir, `case-1.${model}.json`));
      const log = readRunLog(roots, 'case-1', model);
      expect(log.status).toBe('valid');
      if (log.status !== 'valid') continue;
      expect(log.record).toMatchObject({ outcome: 'completed', output_sha256: sha256Hex(canonical), reconciled: false });
      expect(log.record.response_meta?.usage_metadata).toEqual({ prompt_token_count: 100, candidates_token_count: 50, total_token_count: 150 });
      expect(readFileSync(join(roots.localOutputsDir, `case-1.${model}.json`))).toEqual(canonical);
    }
  });

  it('a failure consumes the reservation, saves no output, and is never retried on restart', async () => {
    process.env.GEMINI_QUALITY_EVAL_API_KEY = 'eval-key';
    const fetchSpy = vi.fn().mockImplementation(() => Promise.resolve(errorResponse()));
    useFetch(fetchSpy);

    await captured(() => run(['--eval-root', evalRoot, '--execute']));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(existsSync(join(roots.canonicalOutputsDir, `case-1.${LITE}.json`))).toBe(false);
    const log = readRunLog(roots, 'case-1', LITE);
    expect(log.status === 'valid' && log.record).toMatchObject({
      outcome: 'failed',
      output_sha256: null,
      error_classification: { classification: 'server', httpStatus: 500 },
    });

    fetchSpy.mockClear();
    await captured(() => run(['--eval-root', evalRoot, '--execute']));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never overwrites a pre-existing local file; the ledger copy stays authoritative', async () => {
    process.env.GEMINI_QUALITY_EVAL_API_KEY = 'eval-key';
    mkdirSync(roots.localOutputsDir, { recursive: true });
    const local = join(roots.localOutputsDir, `case-1.${LITE}.json`);
    writeFileSync(local, '{"pre":"existing"}\n');
    useFetch(vi.fn().mockImplementation(() => Promise.resolve(geminiResponse(VALID_BRIEF_JSON))));

    const { result, out } = await captured(() => run(['--eval-root', evalRoot, '--execute']));
    expect(result).toBe(0);
    expect(out).toMatch(/not backed by a completed ledger entry/);
    expect(out).toMatch(/existing local copy differs and was left unchanged/);
    expect(readFileSync(local, 'utf8')).toBe('{"pre":"existing"}\n');
    expect(getPairState(roots, 'case-1', LITE)).toBe('completed');
  });
});

describe('--execute with model output that fails validation', () => {
  it('preserves the exact model text as an invalid result, never as an output, and never re-sends it', async () => {
    process.env.GEMINI_QUALITY_EVAL_API_KEY = 'eval-key';
    const fetchSpy = invalidOutputFetch();
    useFetch(fetchSpy);

    const { result, out } = await captured(() => run(['--eval-root', evalRoot, '--execute']));
    expect(result).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(out).toMatch(/2 invalid \(output failed validation; preserved for review\)/);

    for (const [model, text, error] of [
      [LITE, SCHEMA_INVALID_TEXT, /why_it_matters/],
      [FLASH, PROSE_TEXT, /Invalid JSON returned by Gemini API/],
    ] as const) {
      const preserved = readFileSync(join(roots.rejectedOutputsDir, `case-1.${model}.rejected.txt`));
      expect(preserved.toString('utf8')).toBe(text);
      const log = readRunLog(roots, 'case-1', model);
      expect(log.status === 'valid' && log.record).toMatchObject({
        outcome: 'invalid',
        output_sha256: sha256Hex(preserved),
        error_classification: { classification: 'invalid_output' },
        mechanical_validation: { ran: true, valid: false },
      });
      expect(log.status === 'valid' && log.record.mechanical_validation.errors[0]).toMatch(error);
      expect(getPairState(roots, 'case-1', model)).toBe('invalid');
      expect(existsSync(join(roots.canonicalOutputsDir, `case-1.${model}.json`))).toBe(false);
      expect(existsSync(join(roots.localOutputsDir, `case-1.${model}.json`))).toBe(false);
    }

    fetchSpy.mockClear();
    await captured(() => run(['--eval-root', evalRoot, '--execute']));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not preserve invalid output that contains the API key (recorded as failed instead)', async () => {
    process.env.GEMINI_QUALITY_EVAL_API_KEY = 'eval-key-plain-format-xyz';
    useFetch(vi.fn().mockImplementation(() => Promise.resolve(geminiResponse('echo eval-key-plain-format-xyz'))));
    await captured(() => run(['--eval-root', evalRoot, '--execute']));
    expect(readdirSync(roots.rejectedOutputsDir)).toEqual([]);
    const log = readRunLog(roots, 'case-1', LITE);
    expect(log.status === 'valid' && log.record).toMatchObject({ outcome: 'failed', output_sha256: null });
    expect(log.status === 'valid' && log.record.error_message).toMatch(/contained the API key; not preserved/);
  });
});

describe('switching worktree / eval root on the same machine', () => {
  it('never repeats a completed or failed pair, and gives worktree B the completed output without a request', async () => {
    process.env.GEMINI_QUALITY_EVAL_API_KEY = 'eval-key';
    const fetchSpy = mixedFetch();
    useFetch(fetchSpy);
    await captured(() => run(['--eval-root', evalRoot, '--execute']));
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const evalRootB = join(testRoot, 'worktree-b', 'eval');
    writeCaseFixtures(evalRootB);
    const rootsB = resolveLedgerRoots(evalRootB, ledgerRoot);
    fetchSpy.mockClear();
    const { result } = await captured(() => run(['--eval-root', evalRootB, '--execute']));
    expect(result).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readFileSync(join(rootsB.localOutputsDir, `case-1.${LITE}.json`))).toEqual(
      readFileSync(join(roots.canonicalOutputsDir, `case-1.${LITE}.json`))
    );
    expect(existsSync(join(rootsB.localOutputsDir, `case-1.${FLASH}.json`))).toBe(false);

    // Even after worktree A is deleted entirely, B keeps working from the ledger.
    rmSync(join(testRoot, 'worktree-a'), { recursive: true, force: true });
    const { result: again } = await captured(() => run(['--eval-root', evalRootB, '--reconcile']));
    expect(again).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('cannot obtain a fresh 24-request budget from another checkout', async () => {
    const otherRoots = resolveLedgerRoots(join(testRoot, 'worktree-other', 'eval'), ledgerRoot);
    await ensureLedgerDirs(otherRoots);
    const otherIds = new Set(Array.from({ length: 12 }, (_, i) => `other-${i}`));
    for (const id of otherIds) for (const m of [LITE, FLASH]) expect((await reserveNext(otherRoots, id, m, otherIds)).ok).toBe(true);

    process.env.GEMINI_QUALITY_EVAL_API_KEY = 'eval-key';
    const fetchSpy = mixedFetch();
    useFetch(fetchSpy);
    const evalRootB = join(testRoot, 'worktree-b', 'eval');
    writeCaseFixtures(evalRootB);
    const { out } = await captured(() => run(['--eval-root', evalRootB, '--execute']));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out).toMatch(/Hard cap reached/);
    expect(readdirSync(join(ledgerRoot, 'request-budget'))).toHaveLength(24);
  });
});

describe('crash at each write boundary (real runner code; the next write fails)', () => {
  const asNonRoot = process.getuid?.() === 0 ? it.skip : it;

  async function crashWhileWriting(
    dir: 'canonicalOutputsDir' | 'rejectedOutputsDir' | 'runLogsDir' | 'localOutputsDir',
    fetchImpl: () => ReturnType<typeof vi.fn> = mixedFetch
  ): Promise<void> {
    await ensureLedgerDirs(roots);
    chmodSync(roots[dir], 0o555);
    try {
      process.env.GEMINI_QUALITY_EVAL_API_KEY = 'eval-key';
      useFetch(fetchImpl());
      await expect(captured(() => run(['--eval-root', evalRoot, '--execute']))).rejects.toThrow(/EACCES/);
    } finally {
      chmodSync(roots[dir], 0o755);
    }
  }

  asNonRoot('after the request, before the canonical output: ambiguous, never re-sent', async () => {
    await crashWhileWriting('canonicalOutputsDir');
    expect(getPairState(roots, 'case-1', LITE)).toBe('ambiguous');
    const fetchSpy = mixedFetch();
    useFetch(fetchSpy);
    await captured(() => run(['--eval-root', evalRoot, '--execute']));
    expect(fetchSpy).toHaveBeenCalledTimes(1); // only the never-attempted 3.6 pair
    expect(getPairState(roots, 'case-1', LITE)).toBe('ambiguous');
  });

  asNonRoot('after the canonical output, before the run-log: incomplete until offline reconciliation', async () => {
    await crashWhileWriting('runLogsDir');
    expect(getPairState(roots, 'case-1', LITE)).toBe('incomplete');

    const before = snapshotTree(testRoot);
    const dry = await captured(() => run(['--eval-root', evalRoot]));
    expect(dry.out).toMatch(/\[incomplete\s*\] case-1/);
    expect(snapshotTree(testRoot)).toEqual(before); // dry-run stays read-only

    delete process.env.GEMINI_QUALITY_EVAL_API_KEY; // --reconcile needs no key
    const fetchSpy = vi.fn(() => Promise.reject(new Error('no requests during reconciliation')));
    useFetch(fetchSpy);
    const rec = await captured(() => run(['--eval-root', evalRoot, '--reconcile']));
    expect(rec.result).toBe(0);
    expect(rec.out).toMatch(/Reconciled case-1 x gemini-3.5-flash-lite/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getPairState(roots, 'case-1', LITE)).toBe('completed');
    const log = readRunLog(roots, 'case-1', LITE);
    expect(log.status === 'valid' && log.record.reconciled).toBe(true);
    expect(existsSync(join(roots.localOutputsDir, `case-1.${LITE}.json`))).toBe(true);
  });

  asNonRoot('invalid output: after the request, before the rejected output — ambiguous, never re-sent', async () => {
    await crashWhileWriting('rejectedOutputsDir', invalidOutputFetch);
    expect(getPairState(roots, 'case-1', LITE)).toBe('ambiguous');
    const fetchSpy = invalidOutputFetch();
    useFetch(fetchSpy);
    await captured(() => run(['--eval-root', evalRoot, '--execute']));
    expect(fetchSpy).toHaveBeenCalledTimes(1); // only the never-attempted 3.6 pair
  });

  asNonRoot("invalid output: after the rejected output, before the run-log — reconciled to 'invalid' offline", async () => {
    await crashWhileWriting('runLogsDir', invalidOutputFetch);
    expect(getPairState(roots, 'case-1', LITE)).toBe('incomplete');
    delete process.env.GEMINI_QUALITY_EVAL_API_KEY;
    const fetchSpy = vi.fn();
    useFetch(fetchSpy);
    const rec = await captured(() => run(['--eval-root', evalRoot, '--reconcile']));
    expect(rec.result).toBe(0);
    expect(rec.out).toMatch(/Reconciled case-1 x gemini-3.5-flash-lite/);
    expect(getPairState(roots, 'case-1', LITE)).toBe('invalid');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  asNonRoot('after the run-log, before the local copy: completed; reconciliation only materializes', async () => {
    await crashWhileWriting('localOutputsDir');
    expect(getPairState(roots, 'case-1', LITE)).toBe('completed');
    expect(existsSync(join(roots.localOutputsDir, `case-1.${LITE}.json`))).toBe(false);
    const fetchSpy = vi.fn();
    useFetch(fetchSpy);
    const rec = await captured(() => run(['--eval-root', evalRoot, '--reconcile']));
    expect(rec.result).toBe(0);
    expect(rec.out).not.toMatch(/Reconciled/);
    expect(rec.out).toMatch(/Copied verified output for case-1 x gemini-3.5-flash-lite/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('unsafe ledger states', () => {
  it('refuses a legacy per-experiment ledger in every mode, changing nothing and sending nothing', async () => {
    mkdirSync(join(ledgerRoot, 'experiments', 'lite-vs-36-flash-12case-comparison', 'reservations'), { recursive: true });
    writeFileSync(join(ledgerRoot, 'experiments', 'lite-vs-36-flash-12case-comparison', 'reservations', `case-1.${LITE}.reserved`), '{}');
    const before = snapshotTree(ledgerRoot);
    process.env.GEMINI_QUALITY_EVAL_API_KEY = 'eval-key';
    const fetchSpy = vi.fn();
    useFetch(fetchSpy);
    for (const mode of [[], ['--reconcile'], ['--execute']]) {
      const { result, out } = await captured(() => run(['--eval-root', evalRoot, ...mode]));
      expect(result).toBe(1);
      expect(out).toMatch(/legacy per-experiment ledger layout/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(snapshotTree(ledgerRoot)).toEqual(before);
  });

  it('refuses to execute or reconcile when a planned pair is corrupt, repeating nothing', async () => {
    process.env.GEMINI_QUALITY_EVAL_API_KEY = 'eval-key';
    useFetch(vi.fn().mockImplementation(() => Promise.resolve(geminiResponse(VALID_BRIEF_JSON))));
    await captured(() => run(['--eval-root', evalRoot, '--execute']));
    writeFileSync(join(roots.canonicalOutputsDir, `case-1.${LITE}.json`), '{"tampered":true}\n');

    const fetchSpy = vi.fn();
    useFetch(fetchSpy);
    for (const mode of [['--reconcile'], ['--execute']]) {
      const { result, out } = await captured(() => run(['--eval-root', evalRoot, ...mode]));
      expect(result).toBe(1);
      expect(out).toMatch(/does not match the run-log/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
