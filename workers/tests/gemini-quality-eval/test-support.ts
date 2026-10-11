/**
 * Shared fixtures for the Phase 2 runner/ledger tests (vitest.ledger.config.ts).
 * Test-only: never imported by the runner or the ledger.
 */
import { afterAll, beforeAll, expect } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultLedgerRoot } from './ledger';
import type { EvalCase, EvalModel } from './harness';
import type { RunLogRecord, RunOutcome } from './runner';

export const WORKERS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const VITE_NODE_BIN = join(WORKERS_DIR, 'node_modules', '.bin', 'vite-node');
export const MODELS = ['gemini-3.5-flash-lite', 'gemini-3.6-flash'] as const;

/** A mechanically valid event brief for eventBriefCase() (grounded in its article id 1). */
export const VALID_BRIEF = {
  summary: 'The council approved the transit expansion after months of debate and public comment.',
  why_it_matters: 'Determines whether a major transit project proceeds.',
  key_developments: ['The council approved the expansion by a 7-2 vote.'],
  key_entities: [],
  uncertainties: [],
  source_references: [{ article_id: 1, claim_context: 'Council approved the expansion' }],
};
export const VALID_BRIEF_JSON = JSON.stringify(VALID_BRIEF);

export function eventBriefCase(id: string): EvalCase {
  return {
    id,
    task: 'event_brief',
    scenario_category: 'test',
    description: 'test case',
    event: { title: 'Council vote', description: 'A vote', severity: 'low' },
    articles: [{ id: 1, source_id: 1, source: 'Test Source', title: 'Headline', summary: 'summary', raw_content: null, published_at: null }],
    must_preserve_facts: ['x'],
    must_not_invent: ['x'],
    known_ambiguities: ['x'],
    validation_notes: 'x',
  };
}

/** Writes event-brief case fixtures into `<evalRoot>/cases/` (one per id). */
export function writeCaseFixtures(evalRoot: string, ids: readonly string[] = ['case-1']): EvalCase[] {
  mkdirSync(join(evalRoot, 'cases'), { recursive: true });
  return ids.map((id) => {
    const c = eventBriefCase(id);
    writeFileSync(join(evalRoot, 'cases', `${id}.json`), JSON.stringify(c));
    return c;
  });
}

export function geminiResponse(text: string, status = 200): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
    }),
    { status }
  );
}

export function errorResponse(): Response {
  return new Response(JSON.stringify({ error: { message: 'Internal error', code: 500 } }), { status: 500 });
}

export function makeKnownIds(n: number): Set<string> {
  return new Set(Array.from({ length: n }, (_, i) => `case-${i}`));
}

export function makeRunLog(caseId: string, model: EvalModel, outcome: RunOutcome, outputSha256: string | null = null): RunLogRecord {
  const ok = outcome === 'completed';
  return {
    experiment_id: 'test',
    case_id: caseId,
    task: 'event_brief',
    model,
    reserved_at: new Date().toISOString(),
    recorded_at: new Date().toISOString(),
    outcome,
    response_meta: null,
    error_classification: ok
      ? null
      : { classification: outcome === 'invalid' ? 'invalid_output' : 'unknown', httpStatus: null, apiStatus: null, quotaIds: [], retryAfterSeconds: null },
    error_message: ok ? null : outcome === 'invalid' ? 'simulated validation failure' : 'simulated failure',
    mechanical_validation:
      outcome === 'failed'
        ? { ran: false, valid: null, errors: [] }
        : { ran: true, valid: ok, errors: ok ? [] : ['simulated validation failure'] },
    output_sha256: outputSha256,
    reconciled: false,
  };
}

/** Recursive listing (path + size), concatenated content optional — for leak checks and snapshots. */
export function snapshotTree(dir: string): string[] {
  if (!existsSync(dir)) return ['<absent>'];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(`${p}/`, ...snapshotTree(p));
    else out.push(`${p}:${readFileSync(p).length}`);
  }
  return out.sort();
}

/** Every file under `dir`, recursively, concatenated. */
export function readAllFiles(dir: string): string {
  if (!existsSync(dir)) return '';
  let out = '';
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    out += entry.isDirectory() ? readAllFiles(p) : readFileSync(p, 'utf8');
  }
  return out;
}

/**
 * Registers a suite-level check that the REAL user-level ledger is byte-for-
 * byte-size identical before and after this test file (in practice: still
 * absent). Complements resolveLedgerRoots' refusal of the real ledger under Vitest.
 */
export function guardRealLedgerUnchanged(): void {
  let before: string[];
  beforeAll(() => {
    before = snapshotTree(defaultLedgerRoot());
  });
  afterAll(() => {
    expect(snapshotTree(defaultLedgerRoot())).toEqual(before);
  });
}

/** Environment for child processes: not a Vitest worker, and no Gemini keys of any kind. */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.VITEST;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;
  delete env.GEMINI_API_KEY;
  if (!('GEMINI_QUALITY_EVAL_API_KEY' in extra)) delete env.GEMINI_QUALITY_EVAL_API_KEY;
  return env;
}
