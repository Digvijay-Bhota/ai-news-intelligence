/**
 * Real-filesystem tests for pair-state classification, verified canonical
 * outputs, reporting/scoring from any checkout, and offline reconciliation
 * (ledger-state.ts). Runs under vitest.ledger.config.ts. No network at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureLedgerDirs,
  listReservedPairs,
  readRunLog,
  reserveNext,
  resolveLedgerRoots,
  sha256Hex,
  writeCanonicalOutputOnce,
  writeRejectedOutputOnce,
  writeRunLogOnce,
  type LedgerRoots,
} from './gemini-quality-eval/ledger';
import {
  checkScorable,
  findCorruptPairs,
  getPairStatus,
  ledgerOutputSource,
  loadVerifiedOutput,
  loadVerifiedRejectedOutput,
  reconcileAndMaterialize,
} from './gemini-quality-eval/ledger-state';
import { buildComparisonReport, renderReport, type EvalCase, type EvalModel } from './gemini-quality-eval/harness';
import { VALID_BRIEF, guardRealLedgerUnchanged, makeRunLog, writeCaseFixtures } from './gemini-quality-eval/test-support';

guardRealLedgerUnchanged();

const LITE: EvalModel = 'gemini-3.5-flash-lite';
const FLASH: EvalModel = 'gemini-3.6-flash';

let tmpDir: string;
let ledgerRoot: string;
let cases: EvalCase[];
let rootsA: LedgerRoots;
/** A second checkout: different eval root, empty local outputs/, same ledger. */
let rootsB: LedgerRoots;
const known = new Set(['case-1', 'case-2', 'case-3']);

async function ambiguous(r: LedgerRoots, caseId: string, model: EvalModel): Promise<void> {
  expect((await reserveNext(r, caseId, model, known)).ok).toBe(true);
}
/** Crash between canonical output and run-log. */
async function incomplete(r: LedgerRoots, caseId: string, model: EvalModel, output: unknown = VALID_BRIEF): Promise<string> {
  await ambiguous(r, caseId, model);
  return (await writeCanonicalOutputOnce(r, caseId, model, output)).sha256;
}
/** The runner's success order: reservation -> canonical output -> completing run-log. */
async function completed(r: LedgerRoots, caseId: string, model: EvalModel): Promise<string> {
  const sha = await incomplete(r, caseId, model);
  await writeRunLogOnce(r, caseId, model, makeRunLog(caseId, model, 'completed', sha));
  return sha;
}
/** The runner's invalid-output order: reservation -> rejected raw text -> 'invalid' run-log. */
async function invalid(r: LedgerRoots, caseId: string, model: EvalModel, text: string): Promise<string> {
  await ambiguous(r, caseId, model);
  const { sha256 } = await writeRejectedOutputOnce(r, caseId, model, text);
  await writeRunLogOnce(r, caseId, model, makeRunLog(caseId, model, 'invalid', sha256));
  return sha256;
}
async function failed(r: LedgerRoots, caseId: string, model: EvalModel): Promise<void> {
  await ambiguous(r, caseId, model);
  await writeRunLogOnce(r, caseId, model, makeRunLog(caseId, model, 'failed'));
}
const canonicalPath = (caseId: string, model: EvalModel) => join(rootsA.canonicalOutputsDir, `${caseId}.${model}.json`);

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'gemini-ledger-state-test-'));
  ledgerRoot = join(tmpDir, 'user-ledger');
  const evalRootA = join(tmpDir, 'worktree-a', 'eval');
  const evalRootB = join(tmpDir, 'worktree-b', 'eval');
  cases = writeCaseFixtures(evalRootA, [...known]);
  writeCaseFixtures(evalRootB, [...known]);
  rootsA = resolveLedgerRoots(evalRootA, ledgerRoot);
  rootsB = resolveLedgerRoots(evalRootB, ledgerRoot);
  await ensureLedgerDirs(rootsA);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('verified canonical outputs', () => {
  it('a completed output written from worktree A is readable, hash-verified, from worktree B with no local copy', async () => {
    const sha = await completed(rootsA, 'case-1', LITE);
    expect(existsSync(rootsB.localOutputsDir)).toBe(false);
    const v = loadVerifiedOutput(rootsB, 'case-1', LITE);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.output).toEqual(VALID_BRIEF);
      expect(v.sha256).toBe(sha);
    }
  });

  it('rejects a tampered canonical output (SHA-256 mismatch) and never returns it', async () => {
    await completed(rootsA, 'case-1', LITE);
    writeFileSync(canonicalPath('case-1', LITE), JSON.stringify({ ...VALID_BRIEF, summary: 'Tampered but still well-formed summary text here.' }));
    const status = getPairStatus(rootsB, 'case-1', LITE);
    expect(status.state).toBe('corrupt');
    expect(status.problem).toMatch(/does not match the run-log/);
    expect(loadVerifiedOutput(rootsB, 'case-1', LITE).ok).toBe(false);
    expect(checkScorable(rootsB, cases[0], LITE)).toMatchObject({ ok: false });
  });

  it.each([
    ['canonical output deleted after completion', async () => {
      await completed(rootsA, 'case-1', LITE);
      rmSync(canonicalPath('case-1', LITE));
    }, /canonical output is missing/],
    ['run-log is not JSON', async () => {
      await incomplete(rootsA, 'case-1', LITE);
      writeFileSync(join(rootsA.runLogsDir, 'case-1.gemini-3.5-flash-lite.run.json'), '{ truncated');
    }, /not valid JSON/],
    ['completed run-log without a valid SHA-256', async () => {
      await incomplete(rootsA, 'case-1', LITE);
      await writeRunLogOnce(rootsA, 'case-1', LITE, makeRunLog('case-1', LITE, 'completed', 'not-a-hash'));
    }, /no valid output_sha256/],
    ['run-log belongs to a different pair', async () => {
      await incomplete(rootsA, 'case-1', LITE);
      await writeRunLogOnce(rootsA, 'case-1', LITE, makeRunLog('case-2', LITE, 'completed', 'a'.repeat(64)));
    }, /identifies case-2/],
    ['failed run-log but an output exists', async () => {
      await incomplete(rootsA, 'case-1', LITE);
      await writeRunLogOnce(rootsA, 'case-1', LITE, makeRunLog('case-1', LITE, 'failed'));
    }, /output exists for a failed run/],
    ['run-log without a reservation', async () => {
      await writeRunLogOnce(rootsA, 'case-1', LITE, makeRunLog('case-1', LITE, 'failed'));
    }, /without a reservation/],
    ['canonical output without a reservation', async () => {
      await writeCanonicalOutputOnce(rootsA, 'case-1', LITE, VALID_BRIEF);
    }, /without a reservation/],
  ])('reports corrupt (never success) when: %s', async (_label, arrange, problem) => {
    await arrange();
    const status = getPairStatus(rootsB, 'case-1', LITE);
    expect(status.state).toBe('corrupt');
    expect(status.problem).toMatch(problem);
    expect(loadVerifiedOutput(rootsB, 'case-1', LITE).ok).toBe(false);
    expect(findCorruptPairs(rootsB, [{ caseId: 'case-1', model: LITE }])).toHaveLength(1);
    const [result] = buildComparisonReport(cases.slice(0, 1), ledgerOutputSource(rootsB).readOutput, () => ({ status: 'none' }), ledgerOutputSource(rootsB).explainUnavailable);
    expect(result.status).toBe('corrupt_output');
  });
});

describe('report and scoring from a fresh worktree read the shared ledger', () => {
  it('reports every state distinctly and never treats a local-only file as a saved output', async () => {
    await completed(rootsA, 'case-1', LITE);
    await failed(rootsA, 'case-1', FLASH);
    await ambiguous(rootsA, 'case-2', LITE);
    await incomplete(rootsA, 'case-2', FLASH);
    await completed(rootsA, 'case-3', LITE);
    writeFileSync(canonicalPath('case-3', LITE), JSON.stringify(VALID_BRIEF)); // same JSON, different bytes -> hash mismatch
    // Worktree B has a plausible-looking local file for a pair the ledger never attempted.
    mkdirSync(rootsB.localOutputsDir, { recursive: true });
    writeFileSync(join(rootsB.localOutputsDir, `case-3.${FLASH}.json`), JSON.stringify(VALID_BRIEF));

    const source = ledgerOutputSource(rootsB);
    const results = buildComparisonReport(
      cases,
      source.readOutput,
      (caseId, model) => (caseId === 'case-1' && model === LITE
        ? { status: 'valid', score: { reviewer: 'r', factual_consistency: 4, information_preservation: 4, unsupported_claims: 4, uncertainty_handling: 4, usefulness: 4, invented_claims_found: [], missing_facts_found: [], justification: 'ok', overall_verdict: 'pass' } }
        : { status: 'none' }),
      source.explainUnavailable
    );
    const byPair = Object.fromEntries(results.map((r) => [`${r.case_id}.${r.model}`, r.status]));
    expect(byPair).toEqual({
      [`case-1.${LITE}`]: 'scored',
      [`case-1.${FLASH}`]: 'failed',
      [`case-2.${LITE}`]: 'ambiguous',
      [`case-2.${FLASH}`]: 'incomplete',
      [`case-3.${LITE}`]: 'corrupt_output',
      [`case-3.${FLASH}`]: 'missing',
    });
    const text = renderReport(cases, results);
    expect(text).toContain('ledger: request failed (unknown): simulated failure');
    expect(text).toMatch(/1 failed, 1 ambiguous, 1 incomplete, 1 corrupt_output\./);
  });

  it('allows scoring only a verified, mechanically valid output', async () => {
    await completed(rootsA, 'case-1', LITE);
    await failed(rootsA, 'case-1', FLASH);
    await incomplete(rootsA, 'case-2', LITE);
    expect(checkScorable(rootsB, cases[0], LITE)).toEqual({ ok: true });
    expect(checkScorable(rootsB, cases[0], FLASH)).toMatchObject({ ok: false, reason: expect.stringMatching(/ledger state: failed/) });
    expect(checkScorable(rootsB, cases[1], LITE)).toMatchObject({ ok: false, reason: expect.stringMatching(/ledger state: incomplete/) });
    expect(checkScorable(rootsB, cases[1], FLASH)).toMatchObject({ ok: false, reason: expect.stringMatching(/not_attempted/) });
  });
});

describe('offline reconciliation and local materialization', () => {
  const budgetAndReservations = () => [readdirSync(rootsA.budgetDir).length, listReservedPairs(rootsA).length];

  it('completes an interrupted-but-saved run from its verified output, then materializes it, with no new reservation', async () => {
    const sha = await incomplete(rootsA, 'case-1', LITE);
    const before = budgetAndReservations();
    await ensureLedgerDirs(rootsB);

    const report = await reconcileAndMaterialize(rootsB, cases, [{ caseId: 'case-1', model: LITE }]);
    expect(report).toMatchObject({ reconciled: [`case-1 x ${LITE}`], materialized: [`case-1 x ${LITE}`], problems: [] });
    const log = readRunLog(rootsA, 'case-1', LITE);
    expect(log.status === 'valid' && log.record).toMatchObject({ outcome: 'completed', output_sha256: sha, reconciled: true, response_meta: null });
    expect(sha256Hex(readFileSync(join(rootsB.localOutputsDir, `case-1.${LITE}.json`)))).toBe(sha);
    expect(budgetAndReservations()).toEqual(before);

    const again = await reconcileAndMaterialize(rootsB, cases, [{ caseId: 'case-1', model: LITE }]);
    expect(again).toEqual({ reconciled: [], materialized: [], warnings: [], problems: [] });
  });

  it.each([
    ['empty canonical file (crash mid-write)', ''],
    ['output that fails mechanical validation', JSON.stringify({ summary: 'too short' })],
  ])('refuses to reconcile %s and leaves it untouched', async (_label, contents) => {
    await ambiguous(rootsA, 'case-1', LITE);
    writeFileSync(canonicalPath('case-1', LITE), contents);
    const report = await reconcileAndMaterialize(rootsA, cases, [{ caseId: 'case-1', model: LITE }]);
    expect(report.problems).toHaveLength(1);
    expect(report.reconciled).toEqual([]);
    expect(readRunLog(rootsA, 'case-1', LITE)).toEqual({ status: 'absent' });
    expect(readFileSync(canonicalPath('case-1', LITE), 'utf8')).toBe(contents);
    expect(getPairStatus(rootsA, 'case-1', LITE).state).toBe('incomplete');
  });

  it('never overwrites a differing local copy and warns about local files the ledger does not back', async () => {
    await completed(rootsA, 'case-1', LITE);
    await failed(rootsA, 'case-1', FLASH);
    await ensureLedgerDirs(rootsB);
    writeFileSync(join(rootsB.localOutputsDir, `case-1.${LITE}.json`), '{"edited":true}\n');
    writeFileSync(join(rootsB.localOutputsDir, `case-1.${FLASH}.json`), JSON.stringify(VALID_BRIEF));

    const report = await reconcileAndMaterialize(rootsB, cases, [
      { caseId: 'case-1', model: LITE },
      { caseId: 'case-1', model: FLASH },
    ]);
    expect(report.problems).toEqual([]);
    expect(report.warnings).toHaveLength(2);
    expect(report.warnings[0]).toMatch(/differs from the canonical ledger output/);
    expect(report.warnings[1]).toMatch(/not backed by a completed ledger entry \(state: failed\)/);
    expect(readFileSync(join(rootsB.localOutputsDir, `case-1.${LITE}.json`), 'utf8')).toBe('{"edited":true}\n');
  });

  it('reports corrupt pairs as problems without repairing them', async () => {
    await completed(rootsA, 'case-1', LITE);
    rmSync(canonicalPath('case-1', LITE));
    const report = await reconcileAndMaterialize(rootsA, cases, [{ caseId: 'case-1', model: LITE }]);
    expect(report.problems).toEqual([`case-1 x ${LITE}: run-log reports completed but the canonical output is missing`]);
    expect(existsSync(canonicalPath('case-1', LITE))).toBe(false);
  });
});

describe('model output that failed validation is preserved, verified, and never treated as valid', () => {
  const PROSE = 'Here is a summary of the council vote, in prose instead of JSON.';
  const rejectedPath = (caseId: string, model: EvalModel) => join(rootsA.rejectedOutputsDir, `${caseId}.${model}.rejected.txt`);

  it('is readable, byte-exact and hash-verified from another worktree, and reported as invalid (never scorable)', async () => {
    const sha = await invalid(rootsA, 'case-1', LITE, PROSE);
    expect(getPairStatus(rootsB, 'case-1', LITE)).toEqual({ state: 'invalid', problem: null });
    expect(loadVerifiedRejectedOutput(rootsB, 'case-1', LITE)).toEqual({ ok: true, text: PROSE, sha256: sha, errors: ['simulated validation failure'] });
    expect(loadVerifiedOutput(rootsB, 'case-1', LITE).ok).toBe(false);
    expect(checkScorable(rootsB, cases[0], LITE)).toMatchObject({ ok: false, reason: expect.stringMatching(/ledger state: invalid/) });

    const source = ledgerOutputSource(rootsB);
    const [result] = buildComparisonReport(cases.slice(0, 1), source.readOutput, () => ({ status: 'none' }), source.explainUnavailable);
    expect(result.status).toBe('invalid');
    expect(result.output_detail).toContain('simulated validation failure');
    expect(result.output_detail).toContain(rejectedPath('case-1', LITE));
    expect(renderReport(cases.slice(0, 1), [result])).toMatch(/1 invalid,/);
  });

  it('rejects a tampered rejected output (SHA-256 mismatch) as corrupt', async () => {
    await invalid(rootsA, 'case-1', LITE, PROSE);
    writeFileSync(rejectedPath('case-1', LITE), PROSE + ' edited');
    expect(getPairStatus(rootsB, 'case-1', LITE)).toMatchObject({ state: 'corrupt', problem: expect.stringMatching(/rejected output SHA-256 .* does not match/) });
    expect(loadVerifiedRejectedOutput(rootsB, 'case-1', LITE).ok).toBe(false);
    const source = ledgerOutputSource(rootsB);
    const [result] = buildComparisonReport(cases.slice(0, 1), source.readOutput, () => ({ status: 'none' }), source.explainUnavailable);
    expect(result.status).toBe('corrupt_output');
  });

  it("reconciles an interrupted invalid run (rejected text saved, no run-log) to 'invalid' without a request", async () => {
    await ambiguous(rootsA, 'case-1', LITE);
    const { sha256 } = await writeRejectedOutputOnce(rootsA, 'case-1', LITE, PROSE);
    expect(getPairStatus(rootsA, 'case-1', LITE).state).toBe('incomplete');

    const report = await reconcileAndMaterialize(rootsA, cases, [{ caseId: 'case-1', model: LITE }]);
    expect(report).toMatchObject({ reconciled: [`case-1 x ${LITE}`], materialized: [], problems: [] });
    const log = readRunLog(rootsA, 'case-1', LITE);
    expect(log.status === 'valid' && log.record).toMatchObject({
      outcome: 'invalid',
      output_sha256: sha256,
      reconciled: true,
      error_classification: { classification: 'invalid_output' },
      mechanical_validation: { ran: true, valid: false, errors: ['Invalid JSON returned by Gemini API'] },
    });
    expect(existsSync(join(rootsA.localOutputsDir, `case-1.${LITE}.json`))).toBe(false); // never materialized as an output
  });

  it('refuses to reconcile a rejected output that actually passes validation, leaving it untouched', async () => {
    await ambiguous(rootsA, 'case-1', LITE);
    await writeRejectedOutputOnce(rootsA, 'case-1', LITE, JSON.stringify(VALID_BRIEF));
    const report = await reconcileAndMaterialize(rootsA, cases, [{ caseId: 'case-1', model: LITE }]);
    expect(report.problems).toEqual([`case-1 x ${LITE}: interrupted run left a rejected output that now passes validation; left untouched`]);
    expect(readRunLog(rootsA, 'case-1', LITE)).toEqual({ status: 'absent' });
  });
});
