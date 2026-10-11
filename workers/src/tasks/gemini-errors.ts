/**
 * Gemini API error capture and classification.
 *
 * Classification uses only structured fields from the error body (gRPC-style
 * `google.rpc.Status` details, or the snake_case `code` documented for newer
 * endpoints) plus the HTTP status. It never infers a specific quota from a
 * bare HTTP 429 or from free-text messages.
 */

import { ApiError } from '../utils/errors';

export type GeminiFailureClass =
  | 'daily_quota' // a per-day quota for this model is exhausted
  | 'rate_limit' // a per-minute/per-second limit was hit
  | 'quota_unknown' // 429 without enough detail to tell which limit
  | 'server' // 5xx, 408, network failure
  | 'access_denied' // auth, permission, billing or account precondition
  | 'model_not_found'
  | 'invalid_request'
  | 'invalid_output' // unparseable or schema-invalid generated output — ONLY ever GeminiOutputValidationError
  | 'unknown'; // any other, unclassified failure (bug, DB error, etc.) — never escalation-eligible

export interface GeminiErrorDetails {
  httpStatus: number;
  apiStatus: string | null; // e.g. RESOURCE_EXHAUSTED or quota_exceeded
  reason: string | null; // google.rpc.ErrorInfo reason, e.g. API_KEY_INVALID
  quotaIds: string[];
  retryAfterSeconds: number | null;
  safeMessage: string | null;
  model: string;
}

const MAX_ERROR_BODY_CHARS = 16_384;
const MAX_SAFE_MESSAGE_CHARS = 300;

export class GeminiApiError extends ApiError {
  constructor(message: string, public readonly details: GeminiErrorDetails) {
    super(details.httpStatus, message, 'GEMINI_ERROR');
    this.name = 'GeminiApiError';
  }
}

/**
 * Thrown only for a Gemini response that was received but could not be
 * parsed as JSON, or that failed a task's structural/schema validation.
 * This is the sole, explicit signal classifyGeminiFailure treats as
 * 'invalid_output' — the classification that makes a Lite failure
 * potentially eligible for the bounded 3.6 escalation path (see
 * gemini-escalation.ts). It must never be thrown for request/transport
 * problems (those are GeminiApiError) or for unrelated bugs, database
 * errors, or other unexpected failures — those classify as 'unknown' and
 * are never escalation-eligible, even though the router still falls back
 * to the next model for them exactly as it does for invalid_output.
 */
export class GeminiOutputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiOutputValidationError';
  }
}

/** Strips anything resembling an API key from text that may be persisted. */
export function redactSecrets(text: string): string {
  return text
    .replace(/([?&]key=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Parses "43s" / "1.5s" (RetryInfo) or a Retry-After header (seconds or HTTP date). */
export function parseRetryAfter(value: unknown, nowMs: number = Date.now()): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const v = value.trim();
  const seconds = /^(\d+(?:\.\d+)?)s?$/.exec(v);
  if (seconds) return Math.ceil(Number(seconds[1]));
  const date = Date.parse(v);
  if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - nowMs) / 1000));
  return null;
}

function readHeader(response: Response, name: string): string | null {
  try {
    return typeof response.headers?.get === 'function' ? response.headers.get(name) : null;
  } catch {
    return null;
  }
}

async function readBody(response: Response): Promise<Record<string, unknown> | null> {
  try {
    if (typeof response.text !== 'function') return null;
    const text = (await response.text()).slice(0, MAX_ERROR_BODY_CHARS);
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Builds a GeminiApiError from a non-OK response without exposing secrets. */
export async function geminiErrorFromResponse(response: Response, model: string): Promise<GeminiApiError> {
  const body = await readBody(response);
  const err = asRecord(body?.error) ?? body;

  let apiStatus: string | null = null;
  if (typeof err?.status === 'string') apiStatus = err.status;
  else if (typeof err?.code === 'string') apiStatus = err.code;
  else if (typeof err?.type === 'string') apiStatus = err.type;

  let reason: string | null = null;
  const quotaIds: string[] = [];
  let retryAfterSeconds: number | null = null;

  const details = Array.isArray(err?.details) ? err.details : [];
  for (const raw of details) {
    const d = asRecord(raw);
    if (!d) continue;
    const type = typeof d['@type'] === 'string' ? d['@type'] : '';
    if (type.endsWith('google.rpc.QuotaFailure') && Array.isArray(d.violations)) {
      for (const v of d.violations) {
        const quotaId = asRecord(v)?.quotaId;
        if (typeof quotaId === 'string') quotaIds.push(quotaId.slice(0, 200));
      }
    } else if (type.endsWith('google.rpc.RetryInfo')) {
      retryAfterSeconds = parseRetryAfter(d.retryDelay);
    } else if (type.endsWith('google.rpc.ErrorInfo') && typeof d.reason === 'string') {
      reason = d.reason;
    }
  }
  if (retryAfterSeconds === null) retryAfterSeconds = parseRetryAfter(readHeader(response, 'Retry-After'));

  const safeMessage =
    typeof err?.message === 'string' ? redactSecrets(err.message).slice(0, MAX_SAFE_MESSAGE_CHARS) : null;

  // Keep the historical prefix: the retry-budget query matches on '%429%'.
  let message = `Gemini API error: ${response.status} ${response.statusText ?? ''}`.trimEnd();
  if (apiStatus) message += ` [${apiStatus}]`;
  if (quotaIds.length > 0) message += ` quota=${quotaIds.join(',')}`;

  return new GeminiApiError(message, {
    httpStatus: response.status,
    apiStatus,
    reason,
    quotaIds,
    retryAfterSeconds,
    safeMessage,
    model,
  });
}

/** Wraps a fetch-level failure (DNS, reset, abort) as a transient server error. */
export function geminiNetworkError(model: string): GeminiApiError {
  return new GeminiApiError('Gemini API error: network failure', {
    httpStatus: 0,
    apiStatus: null,
    reason: null,
    quotaIds: [],
    retryAfterSeconds: null,
    safeMessage: null,
    model,
  });
}

const ACCESS_REASONS = new Set(['API_KEY_INVALID', 'API_KEY_EXPIRED', 'BILLING_DISABLED', 'CONSUMER_SUSPENDED', 'SERVICE_DISABLED']);
const ACCESS_STATUSES = new Set([
  'UNAUTHENTICATED', 'PERMISSION_DENIED', 'FAILED_PRECONDITION',
  'authentication', 'permission_denied', 'payment_required', 'failed_precondition',
]);

function classifyHttp(status: number, apiStatus: string | null, reason: string | null, quotaIds: string[]): GeminiFailureClass {
  if (status === 429 || apiStatus === 'RESOURCE_EXHAUSTED') {
    if (apiStatus === 'quota_exceeded' || quotaIds.some((q) => /PerDay/i.test(q))) return 'daily_quota';
    if (apiStatus === 'rate_limit_exceeded' || quotaIds.some((q) => /Per(Minute|Second)/i.test(q))) return 'rate_limit';
    return 'quota_unknown';
  }
  if ((reason && ACCESS_REASONS.has(reason)) || (apiStatus && ACCESS_STATUSES.has(apiStatus))) return 'access_denied';
  if (status === 401 || status === 402 || status === 403) return 'access_denied';
  if (status === 404 || apiStatus === 'model_not_found' || apiStatus === 'NOT_FOUND') return 'model_not_found';
  if (status === 0 || status === 408 || status >= 500) return 'server';
  if (status >= 400) return 'invalid_request';
  return 'server';
}

export interface ClassifiedFailure {
  classification: GeminiFailureClass;
  httpStatus: number | null;
  apiStatus: string | null;
  quotaIds: string[];
  retryAfterSeconds: number | null;
}

/**
 * Classifies any error thrown while producing a task's output. Errors without
 * an HTTP status were raised while parsing or validating the generated output.
 */
export function classifyGeminiFailure(error: unknown): ClassifiedFailure {
  if (error instanceof GeminiApiError) {
    const d = error.details;
    return {
      classification: classifyHttp(d.httpStatus, d.apiStatus, d.reason, d.quotaIds),
      httpStatus: d.httpStatus,
      apiStatus: d.apiStatus,
      quotaIds: d.quotaIds,
      retryAfterSeconds: d.retryAfterSeconds,
    };
  }
  if (error instanceof GeminiOutputValidationError) {
    return { classification: 'invalid_output', httpStatus: null, apiStatus: null, quotaIds: [], retryAfterSeconds: null };
  }
  if (error instanceof ApiError) {
    return { classification: classifyHttp(error.status, null, null, []), httpStatus: error.status, apiStatus: null, quotaIds: [], retryAfterSeconds: null };
  }
  // Anything else (TypeError, a database error, a programming bug, ...) is
  // NOT a deterministic output-validation failure and must never be mistaken
  // for one, even though the router still falls back to the next model for
  // it exactly as it does for invalid_output (see model-router.ts).
  return { classification: 'unknown', httpStatus: null, apiStatus: null, quotaIds: [], retryAfterSeconds: null };
}
