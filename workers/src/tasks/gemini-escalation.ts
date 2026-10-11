/**
 * Gemini 3.6 Flash quality-escalation path.
 *
 * Wraps runGeminiTask for the three multi-article synthesis tasks only
 * (event_brief, narrative_delta, claim_comparison). When the full free-tier
 * Flash-Lite route fails because every eligible model produced invalid
 * output — never because of quota, rate limits, server/network errors,
 * access/config problems, or an active cooldown — and a positive escalation
 * budget has been configured and reserved for the day, exactly one bounded
 * attempt against gemini-3.6-flash is made. Any other failure, or a failure
 * to reserve budget, falls back to the existing safe fallback/defer
 * behavior unchanged.
 *
 * This is a distinct mechanism from an operator explicitly putting
 * gemini-3.6-flash into GEMINI_MODEL_ROUTES for a task: that is direct,
 * operator-selected routing, already handled by runGeminiTask's normal
 * cooldown/attempt rules, and is intentionally NOT gated by this budget.
 */

import type { Env } from '../types';
import {
  type AllowedModel,
  type AttemptRecord,
  type GeminiTask,
  type RouterDeps,
  type TaskResult,
  getGeminiAttempts,
  getModelRoute,
  runGeminiTask,
} from './model-router';

export const ESCALATION_MODEL: AllowedModel = 'gemini-3.6-flash';

/** Hard ceiling on the daily escalation budget. No runtime configuration can raise this. */
export const ESCALATION_HARD_MAX_PER_DAY = 2;

export const ESCALATION_ELIGIBLE_TASKS: readonly GeminiTask[] = [
  'event_brief',
  'narrative_delta',
  'claim_comparison',
];

const BUDGET_TABLE = 'gemini_escalation_budget';

export function isEscalationEnabled(env: Pick<Env, 'GEMINI_ESCALATION_ENABLED'>): boolean {
  return env.GEMINI_ESCALATION_ENABLED === 'true';
}

/**
 * Configured daily escalation budget, clamped to [0, ESCALATION_HARD_MAX_PER_DAY].
 * Missing, non-numeric, negative, or fractional values are treated as 0 (disabled),
 * never as "unbounded".
 */
export function getEscalationDailyLimit(env: Pick<Env, 'GEMINI_ESCALATION_DAILY_LIMIT'>): number {
  const raw = env.GEMINI_ESCALATION_DAILY_LIMIT;
  if (raw === undefined) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return 0;
  return Math.min(parsed, ESCALATION_HARD_MAX_PER_DAY);
}

/** Pacific calendar date (YYYY-MM-DD) used as the daily bucket key. */
export function pacificBucketDate(nowMs: number): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(nowMs));
  } catch {
    // Conservative fallback: still a real calendar date, just not Pacific-shifted.
    return new Date(nowMs).toISOString().slice(0, 10);
  }
}

/**
 * Every attempt actually made against the task's configured Lite route must
 * have failed with a deterministic output-validation/schema classification
 * (never skipped via cooldown, never quota/rate-limit/server/access/config),
 * and every model in that route must have been attempted at least once.
 * Any other shape of failure history is treated as ineligible.
 */
export function isEscalationEligibleFailure(
  attempts: AttemptRecord[] | undefined,
  liteRoute: readonly AllowedModel[]
): boolean {
  if (!attempts || attempts.length === 0 || liteRoute.length === 0) return false;

  const attemptedModels = new Set<AllowedModel>();
  for (const a of attempts) {
    if (a.outcome !== 'failed' || a.classification !== 'invalid_output') return false;
    attemptedModels.add(a.model);
  }
  return liteRoute.every((m) => attemptedModels.has(m));
}

/**
 * Atomically reserves one escalation call for (today's Pacific date, model),
 * via a single conditional UPSERT: the DO UPDATE only fires, and only
 * increments reserved_count, when the existing count is still below the
 * cap. When the cap has already been reached, the WHERE clause makes
 * SQLite skip the update entirely — no row is returned, and the persisted
 * count is left untouched, never incremented past the cap. There is no
 * separate read-then-write: a single D1 statement decides and records the
 * outcome atomically, so concurrent callers cannot together exceed `limit`.
 *
 * Fails closed (returns false) on any error, including a missing table —
 * this must never crash or block ordinary Lite processing.
 *
 * `limit` is validated here independently of any caller (e.g.
 * getEscalationDailyLimit): a non-integer, non-finite, zero/negative, or
 * above-hard-ceiling value is rejected before any SQL runs, so a bad limit
 * can never create or modify a budget row.
 */
export async function reserveEscalationBudget(
  env: Pick<Env, 'DB'>,
  model: AllowedModel,
  limit: number,
  nowMs: number = Date.now()
): Promise<boolean> {
  if (!Number.isInteger(limit) || limit <= 0 || limit > ESCALATION_HARD_MAX_PER_DAY) return false;

  const bucketDate = pacificBucketDate(nowMs);
  const now = Math.floor(nowMs / 1000);

  try {
    const row = await env.DB.prepare(
      `INSERT INTO ${BUDGET_TABLE} (bucket_date, model, reserved_count, updated_at)
       VALUES (?1, ?2, 1, ?3)
       ON CONFLICT(bucket_date, model) DO UPDATE SET
         reserved_count = reserved_count + 1,
         updated_at = ?3
       WHERE reserved_count < ?4
       RETURNING reserved_count`
    )
      .bind(bucketDate, model, now, limit)
      .first<{ reserved_count: number }>();

    // A returned row means this call's insert/update actually happened
    // (fresh row at count 1, or an increment while still under the cap).
    // No row means the conditional update was skipped: the cap was already
    // reached, and the stored count was left exactly where it was.
    return typeof row?.reserved_count === 'number';
  } catch {
    // Table missing in this environment, DB unavailable, etc. Escalation is
    // skipped; normal Lite routing/deferral must be unaffected.
    console.warn(JSON.stringify({ event: 'gemini_escalation_budget_unavailable', model, bucket_date: bucketDate }));
    return false;
  }
}

export interface EscalationResult<T> extends TaskResult<T> {
  escalated: boolean;
}

/**
 * Runs the task's normal free-tier Lite route. Only for the three eligible
 * synthesis tasks, and only when every eligibility condition in this module
 * holds, a single bounded gemini-3.6-flash attempt is made on top of an
 * otherwise-exhausted Lite failure. In every other case — disabled,
 * unconfigured, wrong task, ineligible/mixed failure history, budget
 * refused, or the operator already routed this task through 3.6-flash
 * directly — the original Lite outcome (success or failure) is unchanged.
 */
export async function runGeminiTaskWithEscalation<T>(
  env: Env,
  task: GeminiTask,
  attempt: (model: AllowedModel) => Promise<T>,
  deps?: RouterDeps
): Promise<EscalationResult<T>> {
  try {
    const result = await runGeminiTask(env, task, attempt, deps);
    return { ...result, escalated: false };
  } catch (error) {
    if (!ESCALATION_ELIGIBLE_TASKS.includes(task)) throw error;

    const liteRoute = getModelRoute(env, task);
    if (liteRoute.includes(ESCALATION_MODEL)) {
      // Operator-selected direct use of 3.6-flash via GEMINI_MODEL_ROUTES: already
      // tried as an ordinary route model by runGeminiTask above. Not an automatic
      // escalation, so intentionally not gated by the budget below.
      throw error;
    }

    if (!isEscalationEnabled(env)) throw error;

    const limit = getEscalationDailyLimit(env);
    if (limit <= 0) throw error;

    const attempts = getGeminiAttempts(error);
    if (!isEscalationEligibleFailure(attempts, liteRoute)) throw error;

    const reserved = await reserveEscalationBudget(env, ESCALATION_MODEL, limit, deps?.nowMs ? deps.nowMs() : Date.now());
    if (!reserved) throw error;

    // One bounded, unretried attempt. Its output goes through the same
    // validation as every other model; a failure here (including another
    // invalid_output) is a real failure, never masked by the stronger model.
    const value = await attempt(ESCALATION_MODEL);
    return { value, model: ESCALATION_MODEL, attempts: attempts ?? [], escalated: true };
  }
}
