/**
 * End-to-end tests for the Phase 2 comparison-runner CLI orchestration
 * (main/runExperiment from scripts/gemini-quality-comparison-runner.ts)
 * against a real, temporary ledger directory. Runs under
 * vitest.ledger.config.ts (plain Node) because it needs real fs — the
 * reason this file lives alongside gemini-quality-eval-ledger.test.ts
 * rather than in the Workers-pool suite.
 *
 * global.fetch is ALWAYS mocked here — this file never calls the real
 * Gemini API. It exercises the REAL production generator functions and the
 * REAL ledger, with only the network boundary replaced.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../scripts/gemini-quality-comparison-runner';
import { defaultLedgerRoot, ensureLedgerDirs, reserveNext, resolveLedgerRoots } from './gemini-quality-eval/ledger';

const WORKERS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every file under `dir`, recursively, concatenated — for leak checks. */
function readAllFiles(dir: string): string {
  if (!existsSync(dir)) return '';
  let out = '';
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    out += entry.isDirectory() ? readAllFiles(p) : readFileSync(p, 'utf8');
  }
  return out;
}

const VALID_BRIEF_JSON = JSON.stringify({
  summary: 'The council approved the transit expansion after months of debate and public comment.',
  why_it_matters: 'Determines whether a major transit project proceeds.',
  key_developments: ['The council approved the expansion by a 7-2 vote.'],
  key_entities: [],
  uncertainties: [],
  source_references: [{ article_id: 1, claim_context: 'Council approved the expansion' }],
});

function geminiResponse(text: string, status = 200): Response {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 } }),
    { status }
  );
}

function errorResponse(): Response {
  return new Response(JSON.stringify({ error: { message: 'Internal error', code: 500 } }), { status: 500 });
}

/** Recursive listing (path + size) used to prove the real user-level ledger is never touched. */
function snapshotTree(dir: string): string[] {
  if (!existsSync(dir)) return ['<absent>'];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(`${p}/`, ...snapshotTree(p));
    else out.push(`${p}:${readFileSync(p).length}`);
  }
  return out.sort();
}

// Tests must never create or modify the real, shared user-level ledger:
// every main() call below passes a temporary ledgerRoot, and the subprocess
// dry-run test (which uses the real default location) is read-only.
let realLedgerBefore: string[];
beforeAll(() => {
  realLedgerBefore = snapshotTree(defaultLedgerRoot());
});
afterAll(() => {
  expect(snapshotTree(defaultLedgerRoot())).toEqual(realLedgerBefore);
});

let testRoot: string;
/** Eval root of the simulated primary worktree. */
let evalRoot: string;
/** Stand-in for the user-level ledger, shared by every simulated worktree in a test. */
let ledgerRoot: string;
let originalFetch: typeof fetch;
let originalEnv: NodeJS.ProcessEnv;

function run(args: string[]): Promise<number> {
  return main(args, ledgerRoot);
}

function writeCaseFixture(root: string): void {
  mkdirSync(join(root, 'cases'), { recursive: true });
  writeFileSync(
    join(root, 'cases', 'case-1.json'),
    JSON.stringify({
      id: 'case-1',
      task: 'event_brief',
      scenario_category: 'test',
      description: 'test case',
      event: { title: 'Council vote', description: 'A vote', severity: 'low' },
      articles: [{ id: 1, source_id: 1, source: 'Test Source', title: 'Headline', summary: 'summary', raw_content: null, published_at: null }],
      must_preserve_facts: ['x'],
      must_not_invent: ['x'],
      known_ambiguities: ['x'],
      validation_notes: 'x',
    })
  );
}

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'gemini-runner-cli-test-'));
  evalRoot = join(testRoot, 'worktree-a', 'eval');
  ledgerRoot = join(testRoot, 'user-ledger');
  writeCaseFixture(evalRoot);
  originalFetch = global.fetch;
  originalEnv = { ...process.env };
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
  global.fetch = originalFetch;
  process.env = originalEnv;
});

describe('dry-run', () => {
  it('makes zero fetch calls and requires no API key', async () => {
    delete process.env.GEMINI_QUALITY_EVAL_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const fetchSpy = vi.fn(() => {
      throw new Error('fetch must never be called during a dry run');
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const exitCode = await run(['--eval-root', evalRoot, '--experiment-id', 'dryrun-exp']);

    expect(exitCode).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    // Dry-run is read-only: no ledger directories, reservations, budget
    // slots, run-logs, or outputs are created.
    expect(existsSync(ledgerRoot)).toBe(false);
    expect(existsSync(join(evalRoot, 'outputs'))).toBe(false);
  });

  it('actually runs when invoked directly through vite-node (real subprocess, dry-run, no key)', () => {
    const env = { ...process.env };
    delete env.VITEST; // vitest sets this in workers; a real operator shell does not
    delete env.GEMINI_API_KEY;
    delete env.GEMINI_QUALITY_EVAL_API_KEY;
    const result = spawnSync(
      join(WORKERS_DIR, 'node_modules', '.bin', 'vite-node'),
      ['scripts/gemini-quality-comparison-runner.ts', '--', '--eval-root', evalRoot, '--experiment-id', 'direct-exp'],
      { cwd: WORKERS_DIR, env, encoding: 'utf8', timeout: 60_000 }
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Experiment plan — 2 (case, model) pairs');
    expect(result.stdout).toContain('DRY RUN');
    expect(existsSync(join(evalRoot, 'outputs'))).toBe(false);
  }, 60_000);

  it('is the default — execution requires the explicit --execute flag', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('must not be called without --execute');
    });
    global.fetch = fetchSpy as unknown as typeof fetch;
    await run(['--eval-root', evalRoot, '--experiment-id', 'default-exp']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('--execute without a dedicated key', () => {
  it('refuses to run even if the production GEMINI_API_KEY is set, and never calls fetch', async () => {
    delete process.env.GEMINI_QUALITY_EVAL_API_KEY;
    process.env.GEMINI_API_KEY = 'prod-key-should-never-be-used';
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    await expect(run(['--eval-root', evalRoot, '--experiment-id', 'no-key-exp', '--execute'])).rejects.toThrow(
      /GEMINI_QUALITY_EVAL_API_KEY/
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('--execute with a successful response', () => {
  it('reserves, attempts once, validates, and writes output + run-log', async () => {
    process.env.GEMINI_QUALITY_EVAL_API_KEY = 'eval-key';
    // A fresh Response per call — a real Response's body can only be read
    // once, and reusing one mock instance across two calls would mask a
    // real bug behind a spurious "already used" failure on the 2nd call.
    const fetchSpy = vi.fn().mockImplementation(() => Promise.resolve(geminiResponse(VALID_BRIEF_JSON)));
    global.fetch = fetchSpy as unknown as typeof fetch;

    const exitCode = await run(['--eval-root', evalRoot, '--experiment-id', 'ok-exp', '--execute']);
    expect(exitCode).toBe(0);
    // Exactly 2 calls: one per model for the single case (no retries).
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    for (const model of ['gemini-3.5-flash-lite', 'gemini-3.6-flash']) {
      const outputPath = join(evalRoot, 'outputs', `case-1.${model}.json`);
      expect(existsSync(outputPath)).toBe(true);
      const runLogPath = join(ledgerRoot, 'experiments', 'ok-exp', 'run-logs', `case-1.${model}.run.json`);
      const runLog = JSON.parse(readFileSync(runLogPath, 'utf8'));
      expect(runLog.outcome).toBe('completed');
      expect(runLog.response_meta.usage_metadata).toEqual({
        prompt_token_count: 100,
        candidates_token_count: 50,
        total_token_count: 150,
      });
    }
  });
});

describe('--execute after a simulated crash', () => {
  it('skips a reservation left without a run-log (ambiguous) instead of re-sending it', async () => {
    process.env.GEMINI_QUALITY_EVAL_API_KEY = 'eval-key';
    // Simulate a process that reserved a pair and then died before writing
    // its run-log (the request may or may not have reached the API).
    const roots = resolveLedgerRoots(evalRoot, 'crash-exp', ledgerRoot);
    ensureLedgerDirs(roots);
    expect((await reserveNext(roots, 'case-1', 'gemini-3.5-flash-lite', new Set(['case-1']))).ok).toBe(true);

    const fetchSpy = vi.fn().mockImplementation(() => Promise.resolve(geminiResponse(VALID_BRIEF_JSON)));
    global.fetch = fetchSpy as unknown as typeof fetch;
    const exitCode = await run(['--eval-root', evalRoot, '--experiment-id', 'crash-exp', '--execute']);

    expect(exitCode).toBe(0);
    // Only the untouched pair (3.6-flash) is attempted; the ambiguous one is not reused.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(existsSync(join(roots.runLogsDir, 'case-1.gemini-3.5-flash-lite.run.json'))).toBe(false);
    expect(existsSync(join(roots.outputsDir, 'case-1.gemini-3.5-flash-lite.json'))).toBe(false);
    expect(existsSync(join(roots.outputsDir, 'case-1.gemini-3.6-flash.json'))).toBe(true);
  });
});

describe('switching worktree / --eval-root on the same machine', () => {
  it('does not re-send failed pairs from another worktree', async () => {
    process.env.GEMINI_QUALITY_EVAL_API_KEY = 'eval-key';
    const fetchSpy = vi.fn().mockImplementation(() => Promise.resolve(errorResponse()));
    global.fetch = fetchSpy as unknown as typeof fetch;

    await run(['--eval-root', evalRoot, '--experiment-id', 'shared-exp', '--execute']);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // both pairs attempted once, both failed

    // Same case fixture, different checkout path, same user-level ledger.
    const evalRootB = join(testRoot, 'worktree-b', 'eval');
    writeCaseFixture(evalRootB);
    fetchSpy.mockClear();
    const exitCode = await run(['--eval-root', evalRootB, '--experiment-id', 'shared-exp', '--execute']);

    expect(exitCode).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(join(evalRootB, 'outputs', 'case-1.gemini-3.5-flash-lite.json'))).toBe(false);
  });

  it('does not obtain a fresh 24-request budget in another worktree or under another experiment ID', async () => {
    // Another checkout already consumed the entire budget.
    const otherWorktree = resolveLedgerRoots(join(testRoot, 'worktree-other', 'eval'), 'first-exp', ledgerRoot);
    ensureLedgerDirs(otherWorktree);
    const otherIds = new Set(Array.from({ length: 12 }, (_, i) => `other-${i}`));
    for (const id of otherIds) {
      for (const m of ['gemini-3.5-flash-lite', 'gemini-3.6-flash'] as const) {
        expect((await reserveNext(otherWorktree, id, m, otherIds)).ok).toBe(true);
      }
    }

    process.env.GEMINI_QUALITY_EVAL_API_KEY = 'eval-key';
    const fetchSpy = vi.fn().mockImplementation(() => Promise.resolve(geminiResponse(VALID_BRIEF_JSON)));
    global.fetch = fetchSpy as unknown as typeof fetch;
    const errors: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.join(' ')));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const evalRootB = join(testRoot, 'worktree-b', 'eval');
    writeCaseFixture(evalRootB);
    try {
      await run(['--eval-root', evalRootB, '--experiment-id', 'brand-new-exp', '--execute']);
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errors.join('\n')).toMatch(/Hard cap reached/);
    expect(readdirSync(join(ledgerRoot, 'request-budget'))).toHaveLength(24);
  });
});

describe('--execute with a pre-existing output', () => {
  it('refuses to execute, sends nothing, and leaves the existing output untouched', async () => {
    process.env.GEMINI_QUALITY_EVAL_API_KEY = 'eval-key';
    mkdirSync(join(evalRoot, 'outputs'), { recursive: true });
    const existing = join(evalRoot, 'outputs', 'case-1.gemini-3.5-flash-lite.json');
    writeFileSync(existing, '{"pre":"existing"}\n');
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const exitCode = await run(['--eval-root', evalRoot, '--experiment-id', 'preexisting-exp', '--execute']);

    expect(exitCode).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readFileSync(existing, 'utf8')).toBe('{"pre":"existing"}\n');
    expect(existsSync(ledgerRoot)).toBe(false);
  });
});

describe('--execute with a failing response', () => {
  it('consumes the reservation, writes a failed run-log, writes no output, and never retries on restart', async () => {
    process.env.GEMINI_QUALITY_EVAL_API_KEY = 'eval-key';
    const fetchSpy = vi.fn().mockImplementation(() => Promise.resolve(errorResponse()));
    global.fetch = fetchSpy as unknown as typeof fetch;

    await run(['--eval-root', evalRoot, '--experiment-id', 'fail-exp', '--execute']);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // one attempt per model, no retry loop

    const outputPath = join(evalRoot, 'outputs', 'case-1.gemini-3.5-flash-lite.json');
    expect(existsSync(outputPath)).toBe(false);
    const runLogPath = join(ledgerRoot, 'experiments', 'fail-exp', 'run-logs', 'case-1.gemini-3.5-flash-lite.run.json');
    const runLog = JSON.parse(readFileSync(runLogPath, 'utf8'));
    expect(runLog.outcome).toBe('failed');
    expect(runLog.error_classification?.classification).toBe('server');
    expect(runLog.error_classification?.httpStatus).toBe(500);

    // Simulated restart: run again with the same experiment id. The failed
    // pair must be skipped, not retried.
    fetchSpy.mockClear();
    await run(['--eval-root', evalRoot, '--experiment-id', 'fail-exp', '--execute']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never leaks the API key into any persisted run-log or output', async () => {
    process.env.GEMINI_QUALITY_EVAL_API_KEY = 'AIzaSyTopSecretExampleKeyValue12345';
    const fetchSpy = vi.fn().mockRejectedValue(new TypeError('fetch failed: https://generativelanguage.googleapis.com/v1beta/models/x?key=AIzaSyTopSecretExampleKeyValue12345'));
    global.fetch = fetchSpy as unknown as typeof fetch;

    await run(['--eval-root', evalRoot, '--experiment-id', 'secret-exp', '--execute']);

    const runLogPath = join(ledgerRoot, 'experiments', 'secret-exp', 'run-logs', 'case-1.gemini-3.5-flash-lite.run.json');
    const contents = readFileSync(runLogPath, 'utf8');
    expect(contents).not.toContain('AIzaSyTopSecretExampleKeyValue12345');
  });

  it('never leaks a non-AIza-format key echoed back by the API into files or console output', async () => {
    const secret = 'plain-format-eval-secret-xyz';
    process.env.GEMINI_QUALITY_EVAL_API_KEY = secret;
    const fetchSpy = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: 400, status: secret, message: `API key ${secret} not valid` } }), {
          status: 400,
        })
      )
    );
    global.fetch = fetchSpy as unknown as typeof fetch;
    const logged: string[] = [];
    const capture = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(capture);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(capture);

    try {
      await run(['--eval-root', evalRoot, '--experiment-id', 'echo-exp', '--execute']);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const persisted = readAllFiles(ledgerRoot) + readAllFiles(join(evalRoot, 'outputs'));
    expect(persisted).toContain('"outcome": "failed"');
    expect(persisted).not.toContain(secret);
    expect(logged.join('\n')).not.toContain(secret);
  });
});
