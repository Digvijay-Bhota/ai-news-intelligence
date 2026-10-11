/**
 * Isolation and safety tests for the Phase 2 runner: import side effects,
 * the CLI wrapper, real-ledger protection, API-key redaction, and real
 * multi-process --execute concurrency. Runs under vitest.ledger.config.ts.
 * Every network call is mocked (in-process via global.fetch, in child
 * processes via a globalThis.fetch stub installed before the runner loads).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, runCli } from '../scripts/gemini-quality-comparison-runner';
import { defaultLedgerRoot, listReservedPairs, RealLedgerInTestError, resolveLedgerRoots } from './gemini-quality-eval/ledger';
import { getPairState } from './gemini-quality-eval/ledger-state';
import { MAX_EXPERIMENT_REQUESTS } from './gemini-quality-eval/runner';
import {
  MODELS,
  VALID_BRIEF_JSON,
  VITE_NODE_BIN,
  WORKERS_DIR,
  childEnv,
  geminiResponse,
  guardRealLedgerUnchanged,
  readAllFiles,
  writeCaseFixtures,
} from './gemini-quality-eval/test-support';

guardRealLedgerUnchanged();

const RUNNER_MODULE = join(WORKERS_DIR, 'scripts', 'gemini-quality-comparison-runner.ts');

let testRoot: string;
let evalRoot: string;
let ledgerRoot: string;
let originalFetch: typeof fetch;
let originalEnv: NodeJS.ProcessEnv;
let originalArgv: string[];

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'gemini-runner-isolation-test-'));
  evalRoot = join(testRoot, 'worktree-a', 'eval');
  ledgerRoot = join(testRoot, 'user-ledger');
  writeCaseFixtures(evalRoot);
  originalFetch = global.fetch;
  originalEnv = { ...process.env };
  originalArgv = [...process.argv];
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
  global.fetch = originalFetch;
  process.env = originalEnv;
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

function spawnVite(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(VITE_NODE_BIN, args, { cwd: WORKERS_DIR, env, encoding: 'utf8', timeout: 60_000 });
}

describe('importing the runner has no side effects', () => {
  it('in-process: does not parse argv, run, fetch, print, or write — even with --execute and a key present', async () => {
    process.argv = [process.argv[0], RUNNER_MODULE, '--execute', '--eval-root', evalRoot];
    process.env.GEMINI_QUALITY_EVAL_API_KEY = 'eval-key';
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const logSpy = vi.spyOn(console, 'log');
    const errSpy = vi.spyOn(console, 'error');
    const exitCodeBefore = process.exitCode;

    vi.resetModules();
    const mod = await import('../scripts/gemini-quality-comparison-runner');
    await new Promise((r) => setTimeout(r, 50)); // let any stray async work surface

    expect(typeof mod.main).toBe('function');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(exitCodeBefore);
    expect(existsSync(ledgerRoot)).toBe(false);
    expect(existsSync(join(evalRoot, 'outputs'))).toBe(false);
  });

  it('in a real non-Vitest process: importing with --execute arguments and a key runs nothing', () => {
    const helper = join(testRoot, 'import-only.ts');
    writeFileSync(
      helper,
      `globalThis.fetch = () => { throw new Error('FETCH_CALLED'); };
const mod = await import(${JSON.stringify(RUNNER_MODULE)});
process.stdout.write(typeof mod.main === 'function' ? 'IMPORTED\\n' : 'BROKEN\\n');
`
    );
    const result = spawnVite([helper, '--', '--execute', '--eval-root', evalRoot], childEnv({ GEMINI_QUALITY_EVAL_API_KEY: 'eval-key' }));
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('IMPORTED');
    expect(result.stderr).not.toMatch(/FETCH_CALLED|Experiment plan/);
    expect(existsSync(ledgerRoot)).toBe(false);
    expect(existsSync(join(evalRoot, 'outputs'))).toBe(false);
  }, 60_000);

  it('the dedicated CLI wrapper does run (dry-run, real default ledger read-only, no key)', () => {
    const result = spawnVite(['scripts/run-gemini-quality-comparison.ts', '--', '--eval-root', evalRoot], childEnv());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Experiment plan — 2 (case, model) pairs');
    expect(result.stdout).toContain('DRY RUN');
    expect(existsSync(join(evalRoot, 'outputs'))).toBe(false);
    // guardRealLedgerUnchanged() verifies the real ledger was not created or modified.
  }, 60_000);
});

describe('tests cannot silently claim the real user-level ledger', () => {
  it('main() requires an explicit ledger root', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    // @ts-expect-error — deliberately omitting the required ledger root
    await expect(main(['--eval-root', evalRoot])).rejects.toThrow(/explicit ledger root/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('main() refuses the real ledger under Vitest, even when passed explicitly with --execute', async () => {
    process.env.GEMINI_QUALITY_EVAL_API_KEY = 'eval-key';
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    await expect(main(['--eval-root', evalRoot, '--execute'], defaultLedgerRoot())).rejects.toThrow(RealLedgerInTestError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('the dedicated API key never appears in artifacts, run-logs, or CLI output', () => {
  const SECRET = 'plain-format-eval-secret-xyz';

  function captureConsole(): string[] {
    const lines: string[] = [];
    const push = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
    vi.spyOn(console, 'log').mockImplementation(push);
    vi.spyOn(console, 'error').mockImplementation(push);
    return lines;
  }

  it('success and an API error that echoes the key: no key in ledger files, local outputs, or console', async () => {
    process.env.GEMINI_QUALITY_EVAL_API_KEY = SECRET;
    global.fetch = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes('3.6-flash')
          ? new Response(JSON.stringify({ error: { code: 400, status: SECRET, message: `API key ${SECRET} not valid` } }), { status: 400 })
          : geminiResponse(VALID_BRIEF_JSON)
      )
    ) as unknown as typeof fetch;
    const lines = captureConsole();

    expect(await runCli(['--eval-root', evalRoot, '--execute'], ledgerRoot)).toBe(0);
    const persisted = readAllFiles(ledgerRoot) + readAllFiles(join(evalRoot, 'outputs'));
    expect(persisted).toContain('"outcome": "completed"');
    expect(persisted).toContain('"outcome": "failed"');
    expect(persisted).not.toContain(SECRET);
    expect(lines.join('\n')).not.toContain(SECRET);
  });

  it('unexpected and usage errors printed by the CLI have the exact key removed', async () => {
    process.env.GEMINI_QUALITY_EVAL_API_KEY = SECRET;
    global.fetch = vi.fn() as unknown as typeof fetch;
    const lines = captureConsole();

    // An fs error whose message embeds the key (via a path) reaches the top-level handler.
    expect(await runCli(['--eval-root', join(testRoot, SECRET)], ledgerRoot)).toBe(1);
    // A parse error whose message embeds the key (via an option name).
    expect(await runCli([`--${SECRET}`], ledgerRoot)).toBe(2);

    const out = lines.join('\n');
    expect(out).toMatch(/Unexpected error: .*\[REDACTED\]/);
    expect(out).toMatch(/Error: .*\[REDACTED\]/);
    expect(out).not.toContain(SECRET);
  });
});

describe('multi-process concurrency (real child processes running --execute against one ledger)', () => {
  it('4 processes in 4 worktrees never request a pair twice and never exceed 24 requests', async () => {
    const PROCESSES = 4;
    const caseIds = Array.from({ length: 12 }, (_, i) => `case-${String(i).padStart(2, '0')}`);
    const helper = join(testRoot, 'execute-worker.ts');
    writeFileSync(
      helper,
      `const [evalRoot, ledgerRoot] = process.argv.slice(2);
let fetches = 0;
const body = JSON.stringify({ candidates: [{ content: { parts: [{ text: ${JSON.stringify(VALID_BRIEF_JSON)} }] }, finishReason: 'STOP' }] });
globalThis.fetch = async () => { fetches++; return new Response(body, { status: 200 }); };
console.log = () => {};
const { main } = await import(${JSON.stringify(RUNNER_MODULE)});
const code = await main(['--execute', '--eval-root', evalRoot], ledgerRoot);
process.stdout.write('RESULT ' + JSON.stringify({ code, fetches }) + '\\n');
`
    );
    const runWorker = (index: number) =>
      new Promise<{ code: number; fetches: number }>((resolvePromise, reject) => {
        const workerEvalRoot = join(testRoot, `worktree-${index}`, 'eval');
        writeCaseFixtures(workerEvalRoot, caseIds);
        const child = spawn(VITE_NODE_BIN, [helper, '--', workerEvalRoot, ledgerRoot], {
          cwd: WORKERS_DIR,
          env: childEnv({ GEMINI_QUALITY_EVAL_API_KEY: 'eval-key' }),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('error', reject);
        child.on('close', (exit) => {
          const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
          if (exit !== 0 || !line) return reject(new Error(`worker ${index} exited ${exit}: ${stderr}`));
          resolvePromise(JSON.parse(line.slice('RESULT '.length)));
        });
      });

    const results = await Promise.all(Array.from({ length: PROCESSES }, (_, i) => runWorker(i)));
    const totalFetches = results.reduce((n, r) => n + r.fetches, 0);
    const roots = resolveLedgerRoots(evalRoot, ledgerRoot);
    const reserved = listReservedPairs(roots);

    expect(results.map((r) => r.code)).toEqual([0, 0, 0, 0]);
    expect(totalFetches).toBeLessThanOrEqual(MAX_EXPERIMENT_REQUESTS);
    // Exactly one request per reservation: no pair was requested twice.
    expect(totalFetches).toBe(reserved.length);
    for (const { caseId, model } of reserved) expect(getPairState(roots, caseId, model)).toBe('completed');
    expect(readdirSync(roots.budgetDir).filter((f) => f.endsWith('.claim')).length).toBeLessThanOrEqual(MAX_EXPERIMENT_REQUESTS);
    // Every completed pair is backed by its canonical ledger output.
    for (const id of caseIds) for (const m of MODELS) {
      if (getPairState(roots, id, m) === 'completed') expect(existsSync(join(roots.canonicalOutputsDir, `${id}.${m}.json`))).toBe(true);
    }
  }, 90_000);
});
