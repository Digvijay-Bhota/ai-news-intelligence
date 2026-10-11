/**
 * Gemini model router.
 *
 * Runs one logical AI task against an allowlisted, ordered list of models.
 * It is the only retry layer for Gemini calls: attempts are bounded per model
 * and per task, quota-limited models are put on a TTL-bound cooldown in KV so
 * they are not called again until their limit can have reset, and a task whose
 * eligible models are all quota-limited is deferred rather than failed.
 */

import type { Env } from '../types';
import { classifyGeminiFailure, type GeminiFailureClass } from './gemini-errors';

/** Stable, free-tier models this Worker may call. Nothing outside this list is ever used. */
export const ALLOWED_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash'] as const;
export type AllowedModel = (typeof ALLOWED_MODELS)[number];

export type GeminiTask =
  | 'enrichment'
  | 'event_match'
  | 'community_signal'
  | 'event_brief'
  | 'narrative_delta'
  | 'claim_comparison';

const LITE_CHAIN: AllowedModel[] = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];

/**
 * Default preference order per task. Every task defaults to the free-tier
 * Flash-Lite chain, including multi-article grounded synthesis (event_brief,
 * narrative_delta, claim_comparison): the paid gemini-3.6-flash model must
 * never be an automatic, silent fallback. An operator who wants 3.6-flash for
 * a specific task can still opt in explicitly via GEMINI_MODEL_ROUTES, since
 * it remains in ALLOWED_MODELS.
 */
export const DEFAULT_ROUTES: Record<GeminiTask, readonly AllowedModel[]> = {
  enrichment: LITE_CHAIN,
  event_match: LITE_CHAIN,
  community_signal: LITE_CHAIN,
  event_brief: LITE_CHAIN,
  narrative_delta: LITE_CHAIN,
  claim_comparison: LITE_CHAIN,
};

export const MAX_ATTEMPTS_PER_MODEL = 2;
export const MAX_ATTEMPTS_PER_TASK = 3;
const MAX_INLINE_WAIT_SECONDS = 10;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 4_000;
const KV_MIN_TTL_SECONDS = 60;
const RATE_LIMIT_COOLDOWN_MAX_SECONDS = 3_600;
const QUOTA_UNKNOWN_COOLDOWN_SECONDS = 900;
const DAILY_RESET_BUFFER_SECONDS = 300;
/** Hard ceiling on any cooldown, so stored state can never disable a model for good. */
export const MAX_COOLDOWN_SECONDS = 25 * 3_600;
const COOLDOWN_KEY_PREFIX = 'gemini:cooldown:';

const isAllowedModel = (m: unknown): m is AllowedModel =>
  typeof m === 'string' && (ALLOWED_MODELS as readonly string[]).includes(m);

/**
 * Returns the model route for a task. GEMINI_MODEL_ROUTES may override it with
 * JSON such as {"event_brief":["gemini-3.6-flash","gemini-3.5-flash-lite"]};
 * entries outside ALLOWED_MODELS are dropped, never called.
 */
export function getModelRoute(env: Pick<Env, 'GEMINI_MODEL_ROUTES'>, task: GeminiTask): AllowedModel[] {
  const fallback = [...DEFAULT_ROUTES[task]];
  if (!env.GEMINI_MODEL_ROUTES) return fallback;
  try {
    const parsed = JSON.parse(env.GEMINI_MODEL_ROUTES) as Record<string, unknown>;
    const entry = parsed && typeof parsed === 'object' ? parsed[task] : undefined;
    if (!Array.isArray(entry)) return fallback;
    const models = [...new Set(entry.filter(isAllowedModel))];
    return models.length > 0 ? models : fallback;
  } catch {
    console.warn(JSON.stringify({ event: 'gemini_routes_invalid' }));
    return fallback;
  }
}

// ─── Cooldown state ─────────────────────────────────────────────

export interface ModelCooldown {
  model: AllowedModel;
  reason: GeminiFailureClass;
  until: number; // unix seconds
  set_at: number;
  quota_ids?: string[];
}

// Isolate-local mirror of KV: KV is eventually consistent, and this also
// covers tests or incidents where the binding is unavailable.
const memoryCooldowns = new Map<string, ModelCooldown>();

function isActive(c: ModelCooldown | null | undefined, model: string, now: number): c is ModelCooldown {
  return !!c && c.model === model && typeof c.until === 'number' && c.until > now && c.until <= now + MAX_COOLDOWN_SECONDS;
}

export async function getCooldown(env: Pick<Env, 'CACHE'>, model: AllowedModel, now: number): Promise<ModelCooldown | null> {
  const cached = memoryCooldowns.get(model);
  if (isActive(cached, model, now)) return cached;
  memoryCooldowns.delete(model);
  try {
    const raw = await env.CACHE.get(COOLDOWN_KEY_PREFIX + model);
    if (!raw) return null;
    const stored = JSON.parse(raw) as ModelCooldown;
    if (!isActive(stored, model, now)) return null;
    memoryCooldowns.set(model, stored);
    return stored;
  } catch {
    return null; // fail open: attempt bounds still apply
  }
}

export async function setCooldown(env: Pick<Env, 'CACHE'>, cooldown: ModelCooldown): Promise<void> {
  const ttl = Math.min(MAX_COOLDOWN_SECONDS, Math.max(KV_MIN_TTL_SECONDS, cooldown.until - cooldown.set_at));
  const bounded = { ...cooldown, until: Math.min(cooldown.until, cooldown.set_at + MAX_COOLDOWN_SECONDS) };
  memoryCooldowns.set(cooldown.model, bounded);
  console.warn(JSON.stringify({ event: 'gemini_model_cooldown', model: bounded.model, reason: bounded.reason, until: bounded.until, quota_ids: bounded.quota_ids }));
  try {
    await env.CACHE.put(COOLDOWN_KEY_PREFIX + cooldown.model, JSON.stringify(bounded), { expirationTtl: ttl });
  } catch {
    console.warn(JSON.stringify({ event: 'gemini_cooldown_persist_failed', model: bounded.model }));
  }
}

/** Test hook: clears the isolate-local cooldown mirror. */
export function resetModelRouterMemory(): void {
  memoryCooldowns.clear();
}

/** Seconds until the next midnight Pacific time, when Gemini per-day quotas reset. */
export function secondsUntilDailyReset(nowMs: number): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(nowMs));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
    const elapsed = get('hour') * 3600 + get('minute') * 60 + get('second');
    if (!Number.isFinite(elapsed)) throw new Error('unparseable time');
    return 86_400 - elapsed;
  } catch {
    return 6 * 3_600; // conservative: re-probe within a working day
  }
}

// ─── Task execution ─────────────────────────────────────────────

export interface AttemptRecord {
  model: AllowedModel;
  outcome: 'failed' | 'skipped_cooldown';
  classification: GeminiFailureClass;
  http_status?: number | null;
  api_status?: string | null;
  quota_ids?: string[];
  retry_after_seconds?: number | null;
  cooldown_until?: number;
}

export type DeferralReason = 'models_unavailable' | 'access_denied' | 'model_not_found';

/** No eligible model can serve the task right now; this is not the input's fault. */
export class GeminiDeferredError extends Error {
  constructor(
    public readonly task: GeminiTask,
    public readonly reason: DeferralReason,
    public readonly attempts: AttemptRecord[],
    public readonly retryAt: number | null
  ) {
    const summary = attempts
      .map((a) => `${a.model}=${a.outcome === 'skipped_cooldown' ? 'cooldown:' : ''}${a.classification}`)
      .join(', ');
    super(`Gemini ${task} deferred (${reason}): ${summary || 'no attempts'}`);
    this.name = 'GeminiDeferredError';
  }
}

const attemptLog = new WeakMap<object, AttemptRecord[]>();

function recordAttempts(error: unknown, attempts: AttemptRecord[]): void {
  if (error && typeof error === 'object') attemptLog.set(error, attempts);
}

/** Attempts behind an error rethrown by runGeminiTask, for persistence. */
export function getGeminiAttempts(error: unknown): AttemptRecord[] | undefined {
  if (error instanceof GeminiDeferredError) return error.attempts;
  return error && typeof error === 'object' ? attemptLog.get(error) : undefined;
}

/** Safe JSON for ai_logs.metadata describing a task's model attempts, if any. */
export function attemptsMetadata(task: GeminiTask, error: unknown): string | undefined {
  const attempts = getGeminiAttempts(error);
  return attempts && attempts.length > 0 ? JSON.stringify({ task, attempts }) : undefined;
}

export interface RouterDeps {
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

const defaultDeps: RouterDeps = {
  nowMs: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

/** Full-jitter exponential backoff, or Retry-After plus a small jitter when given. */
function retryDelayMs(retryIndex: number, retryAfterSeconds: number | null, deps: RouterDeps): number {
  if (retryAfterSeconds !== null) return retryAfterSeconds * 1000 + Math.floor(deps.random() * 250);
  return Math.floor(deps.random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** retryIndex));
}

export interface TaskResult<T> {
  value: T;
  model: AllowedModel;
  attempts: AttemptRecord[];
}

/**
 * Runs `attempt` (one API call plus parsing/validation) across the task's
 * model route. Resolves with the first valid output. Throws
 * GeminiDeferredError when every eligible model is quota-limited, cooling
 * down, or the account/model configuration is unusable; otherwise rethrows
 * the last underlying error so callers keep their existing failure handling.
 */
export async function runGeminiTask<T>(
  env: Pick<Env, 'CACHE' | 'GEMINI_MODEL_ROUTES'>,
  task: GeminiTask,
  attempt: (model: AllowedModel) => Promise<T>,
  deps: RouterDeps = defaultDeps
): Promise<TaskResult<T>> {
  const attempts: AttemptRecord[] = [];
  let calls = 0;
  let lastError: unknown;
  let nonQuotaFailure = false;

  for (const model of getModelRoute(env, task)) {
    if (calls >= MAX_ATTEMPTS_PER_TASK) break;
    const now = Math.floor(deps.nowMs() / 1000);
    const cooldown = await getCooldown(env, model, now);
    if (cooldown) {
      attempts.push({ model, outcome: 'skipped_cooldown', classification: cooldown.reason, cooldown_until: cooldown.until });
      continue;
    }

    for (let i = 0; i < MAX_ATTEMPTS_PER_MODEL && calls < MAX_ATTEMPTS_PER_TASK; i++) {
      calls++;
      try {
        return { value: await attempt(model), model, attempts };
      } catch (error) {
        lastError = error;
        const f = classifyGeminiFailure(error);
        attempts.push({
          model, outcome: 'failed', classification: f.classification, http_status: f.httpStatus,
          api_status: f.apiStatus, quota_ids: f.quotaIds, retry_after_seconds: f.retryAfterSeconds,
        });
        const canRetry = i + 1 < MAX_ATTEMPTS_PER_MODEL && calls < MAX_ATTEMPTS_PER_TASK;
        const at = Math.floor(deps.nowMs() / 1000);

        switch (f.classification) {
          case 'access_denied':
          case 'model_not_found':
            // Configuration problems: another model would mask them, and the input is not at fault.
            throw new GeminiDeferredError(task, f.classification, attempts, null);
          case 'invalid_request':
            recordAttempts(error, attempts);
            throw error;
          case 'daily_quota':
            await setCooldown(env, { model, reason: 'daily_quota', set_at: at, until: at + secondsUntilDailyReset(deps.nowMs()) + DAILY_RESET_BUFFER_SECONDS, quota_ids: f.quotaIds });
            break;
          case 'rate_limit':
          case 'quota_unknown': {
            const wait = f.retryAfterSeconds;
            if (canRetry && (wait === null || wait <= MAX_INLINE_WAIT_SECONDS)) {
              if (f.classification === 'quota_unknown' || wait !== null) {
                await deps.sleep(retryDelayMs(i, wait, deps));
                continue;
              }
            }
            const seconds = f.classification === 'rate_limit'
              ? Math.min(RATE_LIMIT_COOLDOWN_MAX_SECONDS, Math.max(KV_MIN_TTL_SECONDS, wait ?? KV_MIN_TTL_SECONDS))
              : Math.min(RATE_LIMIT_COOLDOWN_MAX_SECONDS, Math.max(QUOTA_UNKNOWN_COOLDOWN_SECONDS, wait ?? 0));
            await setCooldown(env, { model, reason: f.classification, set_at: at, until: at + seconds, quota_ids: f.quotaIds });
            break;
          }
          case 'server':
            nonQuotaFailure = true;
            if (canRetry) {
              await deps.sleep(retryDelayMs(i, f.retryAfterSeconds !== null && f.retryAfterSeconds <= MAX_INLINE_WAIT_SECONDS ? f.retryAfterSeconds : null, deps));
              continue;
            }
            break;
          case 'invalid_output':
            nonQuotaFailure = true;
            break;
        }
        break; // move on to the next model
      }
    }
  }

  if (!nonQuotaFailure) {
    const untils = attempts.map((a) => a.cooldown_until).filter((u): u is number => typeof u === 'number');
    const known = await Promise.all(getModelRoute(env, task).map((m) => getCooldown(env, m, Math.floor(deps.nowMs() / 1000))));
    for (const c of known) if (c) untils.push(c.until);
    throw new GeminiDeferredError(task, 'models_unavailable', attempts, untils.length ? Math.min(...untils) : null);
  }
  recordAttempts(lastError, attempts);
  throw lastError;
}
