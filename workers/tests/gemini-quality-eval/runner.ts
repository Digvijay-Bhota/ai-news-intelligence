/**
 * Phase 2 comparison-runner — pure logic only.
 *
 * No filesystem access and no network access live in this file. Durable,
 * real-filesystem reservation/output/run-log persistence lives in
 * `ledger.ts` (tested separately, under a plain-Node Vitest config, because
 * the Workers test pool used for everything else in this directory does not
 * implement real fs). Everything here is testable inside the Workers pool
 * with mocked fetch/Response objects, exactly like the rest of this
 * directory's harness.
 *
 * Design note: the fetch wrapper below deliberately clones the Response
 * before reading it for capture, and returns the UNTOUCHED original to the
 * caller. A Response body can only be consumed once; the real production
 * generator functions (via requestGeminiText / geminiErrorFromResponse) read
 * the original response themselves, so reading it a second time ourselves
 * would throw and break them. `Response.clone()` is the standard, spec-
 * compliant way to inspect a response without disturbing its only consumer.
 */

import { redactSecrets, classifyGeminiFailure, type ClassifiedFailure } from '../../src/tasks/gemini-errors';
import { EVAL_MODELS, type EvalCase, type EvalModel, type EvalTask, type ValidationResult } from './harness';

/** Hard, auditable experiment-wide cap — independent of the production escalation budget. */
export const MAX_EXPERIMENT_REQUESTS = 24;

/**
 * Label recorded in every run-log. Not a ledger namespace: pair state is keyed
 * globally by (case, model), so there is exactly one experiment per ledger.
 */
export const EXPERIMENT_ID = 'lite-vs-36-flash-12case-comparison';

const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface PlannedPair {
  case_id: string;
  task: EvalTask;
  model: EvalModel;
}

/**
 * Builds the full, deterministic set of (case, model) pairs for the
 * experiment. Deterministic ordering (cases sorted by id, then EVAL_MODELS
 * order) so two separate invocations always agree on pair identity and
 * order, with no reliance on filesystem directory-listing order.
 *
 * Throws rather than truncating if the case set would ever produce more
 * than MAX_EXPERIMENT_REQUESTS pairs — the 24-request ceiling must hold
 * regardless of how many case fixtures exist, not just because there
 * happen to be exactly 12 today.
 */
export function buildExperimentPlan(cases: EvalCase[]): PlannedPair[] {
  const sorted = [...cases].sort((a, b) => a.id.localeCompare(b.id));
  const plan: PlannedPair[] = [];
  for (const evalCase of sorted) {
    for (const model of EVAL_MODELS) {
      plan.push({ case_id: evalCase.id, task: evalCase.task, model });
    }
  }
  if (plan.length > MAX_EXPERIMENT_REQUESTS) {
    throw new Error(
      `Experiment plan has ${plan.length} (case, model) pairs, exceeding the hard cap of ` +
        `${MAX_EXPERIMENT_REQUESTS}. Reduce the number of case fixtures or models before running.`
    );
  }
  return plan;
}

export interface UsageMetadata {
  prompt_token_count: number | null;
  candidates_token_count: number | null;
  total_token_count: number | null;
}

export interface CapturedResponseMeta {
  http_status: number;
  ok: boolean;
  finish_reason: string | null;
  /** null when the response body did not carry recognizable usage metadata — never fabricated. */
  usage_metadata: UsageMetadata | null;
  /** Whether the response body was readable as JSON for inspection purposes. */
  body_parsed: boolean;
  captured_at: string;
}

function extractUsageMetadata(json: unknown): UsageMetadata | null {
  if (!json || typeof json !== 'object') return null;
  const um = (json as Record<string, unknown>).usageMetadata;
  if (!um || typeof um !== 'object') return null;
  const u = um as Record<string, unknown>;
  const promptTokenCount = typeof u.promptTokenCount === 'number' ? u.promptTokenCount : null;
  const candidatesTokenCount = typeof u.candidatesTokenCount === 'number' ? u.candidatesTokenCount : null;
  const totalTokenCount = typeof u.totalTokenCount === 'number' ? u.totalTokenCount : null;
  if (promptTokenCount === null && candidatesTokenCount === null && totalTokenCount === null) return null;
  return {
    prompt_token_count: promptTokenCount,
    candidates_token_count: candidatesTokenCount,
    total_token_count: totalTokenCount,
  };
}

function extractFinishReason(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const candidates = (json as Record<string, unknown>).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const first = candidates[0];
  if (!first || typeof first !== 'object') return null;
  const fr = (first as Record<string, unknown>).finishReason;
  return typeof fr === 'string' ? fr : null;
}

/**
 * Wraps a fetch implementation so every call's raw response can be captured
 * (status, usageMetadata, finishReason, JSON-parseability) via `onCapture`,
 * without disturbing the response the real caller goes on to read. Never
 * logs or reports the request URL/headers verbatim — only `redactSecrets`-
 * sanitized text ever leaves this function via `onCapture`'s caller.
 */
export function wrapFetchForCapture(
  realFetch: typeof fetch,
  onCapture: (meta: CapturedResponseMeta) => void
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await realFetch(input, init);
    const inspectable = response.clone();
    let bodyParsed = false;
    let usageMetadata: UsageMetadata | null = null;
    let finishReason: string | null = null;
    try {
      const text = await inspectable.text();
      const json = JSON.parse(text);
      bodyParsed = true;
      usageMetadata = extractUsageMetadata(json);
      finishReason = extractFinishReason(json);
    } catch {
      // Not JSON, or unreadable — reported honestly as body_parsed: false.
      // Never fabricate usage/finishReason when the body can't be inspected.
    }
    onCapture({
      http_status: response.status,
      ok: response.ok,
      finish_reason: finishReason,
      usage_metadata: usageMetadata,
      body_parsed: bodyParsed,
      captured_at: new Date().toISOString(),
    });
    return response;
  }) as typeof fetch;
}

/**
 * Allows at most ONE real network request through `realFetch`. Every later
 * call rejects without touching the network. One durable reservation covers
 * exactly one request. Each production generator makes exactly one
 * requestGeminiText call today, but this guard makes that a hard limit
 * instead of an assumption: a future internal retry could not quietly send an
 * unreserved second request.
 */
export function limitFetchToSingleRequest(realFetch: typeof fetch): typeof fetch {
  let used = false;
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    if (used) {
      return Promise.reject(new Error('Refused a second network request under a single reservation'));
    }
    used = true;
    return realFetch(input, init);
  }) as typeof fetch;
}

/** Strips any API key from a URL/text before it is ever logged or persisted. */
export function redactUrlForLogging(url: string): string {
  return redactSecrets(url);
}

/**
 * redactSecrets plus removal of each exact secret value. redactSecrets only
 * recognizes `key=` query parameters and AIza-prefixed keys, so this also
 * covers a key in any other format that ends up in an error message.
 */
export function redactKnownSecrets(text: string, secrets: readonly string[] = []): string {
  let out = redactSecrets(text);
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

/** Applies redactKnownSecrets to every string inside a JSON-shaped value. */
function redactStringsDeep<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === 'string') return redactKnownSecrets(value, secrets) as T;
  if (Array.isArray(value)) return value.map((v) => redactStringsDeep(v, secrets)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactStringsDeep(v, secrets)])
    ) as T;
  }
  return value;
}

export type RunOutcome = 'completed' | 'failed';

export interface RunLogRecord {
  experiment_id: string;
  case_id: string;
  task: EvalTask;
  model: EvalModel;
  reserved_at: string;
  recorded_at: string;
  outcome: RunOutcome;
  response_meta: CapturedResponseMeta | null;
  /** Present only when outcome is 'failed'. */
  error_classification: ClassifiedFailure | null;
  /** Present only when outcome is 'failed'. Never includes a raw URL or API key. */
  error_message: string | null;
  mechanical_validation: { ran: boolean; valid: boolean | null; errors: string[] };
  /** SHA-256 (hex) of the canonical ledger output bytes. Required for 'completed', null for 'failed'. */
  output_sha256: string | null;
  /**
   * True when this completion record was written by offline reconciliation
   * (canonical output found durable but the original process died before
   * recording completion). response_meta is then null: it was never persisted.
   */
  reconciled: boolean;
}

/**
 * Builds the run-log record for one attempted (case, model) pair. Pure:
 * takes the already-captured response metadata and already-classified error
 * (if any) and produces the exact JSON shape persisted to run-logs/. Never
 * invents token counts, never includes a raw URL or key: every string in the
 * record (including API-supplied fields such as apiStatus/quotaIds) is
 * redacted, not only error_message.
 */
export function buildRunLogRecord(params: {
  experimentId: string;
  caseId: string;
  task: EvalTask;
  model: EvalModel;
  reservedAt: string;
  responseMeta: CapturedResponseMeta | null;
  outcome: RunOutcome;
  error?: unknown;
  validation?: ValidationResult | null;
  /** Exact secret values (e.g. the API key) to strip from the persisted error message. */
  secrets?: readonly string[];
  /** Required (and only allowed) for outcome 'completed'. */
  outputSha256?: string | null;
  reconciled?: boolean;
}): RunLogRecord {
  const { experimentId, caseId, task, model, reservedAt, responseMeta, outcome, error, validation, secrets } = params;
  const outputSha256 = params.outputSha256 ?? null;
  if ((outcome === 'completed') !== (outputSha256 !== null && SHA256_HEX.test(outputSha256))) {
    throw new Error(`A '${outcome}' run-log ${outcome === 'completed' ? 'requires' : 'must not carry'} an output SHA-256`);
  }
  const errorMessage =
    error === undefined
      ? null
      : redactKnownSecrets(error instanceof Error ? error.message : String(error), secrets).slice(0, 2000);
  const record: RunLogRecord = {
    experiment_id: experimentId,
    case_id: caseId,
    task,
    model,
    reserved_at: reservedAt,
    recorded_at: new Date().toISOString(),
    outcome,
    response_meta: responseMeta,
    error_classification: outcome === 'failed' ? classifyGeminiFailure(error) : null,
    error_message: outcome === 'failed' ? errorMessage : null,
    mechanical_validation: {
      ran: validation !== undefined && validation !== null,
      valid: validation ? validation.valid : null,
      errors: validation ? validation.errors : [],
    },
    output_sha256: outputSha256,
    reconciled: params.reconciled ?? false,
  };
  return redactStringsDeep(record, secrets ?? []);
}

export type ApiKeyResolution = { ok: true; key: string } | { ok: false; error: string };

/**
 * Resolves the API key for a live (--execute) run. Reads ONLY
 * GEMINI_QUALITY_EVAL_API_KEY — the production GEMINI_API_KEY is never read
 * as a fallback, even if present, so usage on a dedicated key stays
 * independently attributable and a missing dedicated key can never silently
 * fall through to draining the production project's quota.
 */
export function resolveExecutionApiKey(env: Record<string, string | undefined>): ApiKeyResolution {
  const key = env.GEMINI_QUALITY_EVAL_API_KEY;
  if (!key || !key.trim()) {
    return {
      ok: false,
      error:
        'GEMINI_QUALITY_EVAL_API_KEY is required for --execute and must be non-empty. ' +
        'The production GEMINI_API_KEY is never used as a fallback.',
    };
  }
  return { ok: true, key };
}

// ─── Ledger filename conventions (pure — no fs) ────────────────────────────
// Kept here, not in ledger.ts, so the exact naming scheme is unit-testable
// inside the Workers pool without touching real fs.

/** Reuses the existing Phase 1 convention: `<case-id>.<model>.json` under outputs/. */
export function outputFileName(caseId: string, model: EvalModel): string {
  return `${caseId}.${model}.json`;
}

export function reservationFileName(caseId: string, model: EvalModel): string {
  return `${caseId}.${model}.reserved`;
}

export function runLogFileName(caseId: string, model: EvalModel): string {
  return `${caseId}.${model}.run.json`;
}

/** Parses a reservation filename back into its (case, model) pair, or null if it doesn't match. */
export function parseReservationFileName(fileName: string): { caseId: string; model: EvalModel } | null {
  if (!fileName.endsWith('.reserved')) return null;
  const withoutSuffix = fileName.slice(0, -'.reserved'.length);
  for (const model of EVAL_MODELS) {
    const modelSuffix = `.${model}`;
    if (withoutSuffix.endsWith(modelSuffix)) {
      const caseId = withoutSuffix.slice(0, -modelSuffix.length);
      if (caseId) return { caseId, model };
    }
  }
  return null;
}

/**
 * Strictly parses a run-log read from disk. Anything that is not exactly a
 * well-formed record for THIS (case, model) pair is rejected, so a damaged or
 * misplaced run-log can never be mistaken for a completed or failed attempt.
 */
export function parseRunLogRecord(
  raw: unknown,
  caseId: string,
  model: EvalModel
): { ok: true; record: RunLogRecord } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'run-log is not a JSON object' };
  const r = raw as Record<string, unknown>;
  if (r.case_id !== caseId || r.model !== model) {
    return { ok: false, error: `run-log identifies ${String(r.case_id)}.${String(r.model)}, not ${caseId}.${model}` };
  }
  if (r.outcome === 'completed') {
    if (typeof r.output_sha256 !== 'string' || !SHA256_HEX.test(r.output_sha256)) {
      return { ok: false, error: 'completed run-log has no valid output_sha256' };
    }
  } else if (r.outcome === 'failed') {
    if (r.output_sha256 !== null) return { ok: false, error: 'failed run-log must not reference an output' };
  } else {
    return { ok: false, error: `run-log outcome is ${JSON.stringify(r.outcome)}, expected 'completed' or 'failed'` };
  }
  return { ok: true, record: raw as RunLogRecord };
}

/**
 * Pair lifecycle in the shared ledger, in write order:
 *   1. reservation  (before any request — never removed)
 *   2. request       (network; at most one per reservation)
 *   3. canonical output, success only (write-once, fsync'd)
 *   4. run-log       (write-once, fsync'd) — the commit point
 *   5. local outputs/ copy (convenience only, never authoritative)
 */
export type PairState =
  /** No reservation. Safe to reserve. */
  | 'not_attempted'
  /** Reserved, nothing else: the request may or may not have been sent. Never re-sent. */
  | 'ambiguous'
  /** Reserved + canonical output, no run-log: crashed between steps 3 and 4. Offline reconciliation can complete it. */
  | 'incomplete'
  | 'completed'
  | 'failed'
  /** Any combination the write order cannot produce, or a hash mismatch. Never repaired automatically. */
  | 'corrupt';

export type RunLogObservation =
  | { status: 'absent' }
  | { status: 'invalid'; error: string }
  | { status: 'valid'; record: RunLogRecord };

export interface PairObservation {
  reserved: boolean;
  runLog: RunLogObservation;
  /** SHA-256 of the canonical output file's bytes, or null if there is no canonical output. */
  canonicalOutputSha256: string | null;
}

/** Pure classification of a pair's state from what the ledger observed on disk. */
export function classifyPairState(o: PairObservation): { state: PairState; problem: string | null } {
  const corrupt = (problem: string) => ({ state: 'corrupt' as const, problem });
  if (o.runLog.status === 'invalid') return corrupt(`run-log is unreadable: ${o.runLog.error}`);
  const hasOutput = o.canonicalOutputSha256 !== null;
  if (!o.reserved) {
    if (o.runLog.status === 'valid') return corrupt('run-log exists without a reservation');
    if (hasOutput) return corrupt('canonical output exists without a reservation');
    return { state: 'not_attempted', problem: null };
  }
  if (o.runLog.status === 'absent') return { state: hasOutput ? 'incomplete' : 'ambiguous', problem: null };
  const record = o.runLog.record;
  if (record.outcome === 'failed') {
    return hasOutput ? corrupt('canonical output exists for a failed run') : { state: 'failed', problem: null };
  }
  if (!hasOutput) return corrupt('run-log reports completed but the canonical output is missing');
  if (o.canonicalOutputSha256 !== record.output_sha256) {
    return corrupt(
      `canonical output SHA-256 ${o.canonicalOutputSha256} does not match the run-log's ${record.output_sha256}`
    );
  }
  return { state: 'completed', problem: null };
}
