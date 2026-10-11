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
}): RunLogRecord {
  const { experimentId, caseId, task, model, reservedAt, responseMeta, outcome, error, validation, secrets } = params;
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

export type PairState = 'not_attempted' | 'ambiguous' | 'completed' | 'failed';

/** Pure classification of a pair's state given what the ledger observed on disk. */
export function classifyPairState(hasReservation: boolean, runLog: RunLogRecord | null): PairState {
  if (!hasReservation) return 'not_attempted';
  if (!runLog) return 'ambiguous';
  return runLog.outcome === 'completed' ? 'completed' : 'failed';
}
