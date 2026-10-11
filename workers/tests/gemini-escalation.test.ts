/// <reference types="vite/client" />
/**
 * Gemini 3.6 Flash escalation: config parsing, eligibility classification,
 * and the atomic daily budget reservation against a real local D1 binding
 * (Miniflare) — the same pattern as brief-generation-lease.test.ts. No
 * network calls; Gemini "attempts" are plain injected async functions.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
// @ts-expect-error -- untyped pool runtime module (see brief-generation-lease.test.ts)
import { env as workerEnv } from 'cloudflare:test-internal';
import schemaSql from '../../d1/schema.sql?raw';
import {
  ESCALATION_ELIGIBLE_TASKS,
  ESCALATION_HARD_MAX_PER_DAY,
  ESCALATION_MODEL,
  getEscalationDailyLimit,
  isEscalationEligibleFailure,
  isEscalationEnabled,
  pacificBucketDate,
  reserveEscalationBudget,
  runGeminiTaskWithEscalation,
} from '../src/tasks/gemini-escalation';
import { GeminiApiError, GeminiOutputValidationError, classifyGeminiFailure } from '../src/tasks/gemini-errors';
import { resetModelRouterMemory, type AttemptRecord, type RouterDeps } from '../src/tasks/model-router';
import { createMockEnv, createMockKVNamespace } from './setup';
import type { Env } from '../src/types';

const DB = (workerEnv as unknown as { DB: D1Database }).DB;

function splitSql(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^PRAGMA\b/i.test(s));
}

async function run(sql: string): Promise<void> {
  for (const stmt of splitSql(sql)) {
    await DB.prepare(stmt).run();
  }
}

async function budgetRows() {
  return (await DB.prepare('SELECT * FROM gemini_escalation_budget ORDER BY bucket_date, model').all<any>()).results;
}

function makeDeps(startMs = 1_700_000_000_000): RouterDeps {
  return {
    nowMs: () => startMs,
    sleep: vi.fn().mockResolvedValue(undefined),
    random: () => 0,
  };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return createMockEnv({ DB, CACHE: createMockKVNamespace(), ...overrides });
}

const invalidOutputError = (msg = 'Invalid structure: summary must be a string') => new GeminiOutputValidationError(msg);
const genericErrorOf = (msg = 'Something unexpected happened') => new Error(msg);
const typeErrorOf = (msg = "Cannot read properties of undefined (reading 'foo')") => new TypeError(msg);
class FakeDatabaseError extends Error {
  constructor(msg = 'D1_ERROR: no such table: articles_raw') {
    super(msg);
    this.name = 'FakeDatabaseError';
  }
}
const dailyQuotaError = (model: string) =>
  new GeminiApiError('Gemini API error: 429 [quota_exceeded]', {
    httpStatus: 429, apiStatus: 'quota_exceeded', reason: null, quotaIds: [], retryAfterSeconds: null, safeMessage: null, model,
  });
const rateLimitError = (model: string) =>
  new GeminiApiError('Gemini API error: 429 [rate_limit_exceeded]', {
    httpStatus: 429, apiStatus: 'rate_limit_exceeded', reason: null, quotaIds: [], retryAfterSeconds: 3600, safeMessage: null, model,
  });
const serverErrorOf = (model: string) =>
  new GeminiApiError('Gemini API error: 500', { httpStatus: 500, apiStatus: null, reason: null, quotaIds: [], retryAfterSeconds: null, safeMessage: null, model });
const accessDeniedErrorOf = (model: string) =>
  new GeminiApiError('Gemini API error: 403', { httpStatus: 403, apiStatus: null, reason: null, quotaIds: [], retryAfterSeconds: null, safeMessage: null, model });
const modelNotFoundErrorOf = (model: string) =>
  new GeminiApiError('Gemini API error: 404', { httpStatus: 404, apiStatus: null, reason: null, quotaIds: [], retryAfterSeconds: null, safeMessage: null, model });
const invalidRequestErrorOf = (model: string) =>
  new GeminiApiError('Gemini API error: 400', { httpStatus: 400, apiStatus: null, reason: null, quotaIds: [], retryAfterSeconds: null, safeMessage: null, model });

beforeEach(async () => {
  resetModelRouterMemory();
  await run(schemaSql);
});

describe('gemini-escalation: configuration', () => {
  it('is disabled unless the switch is exactly "true"', () => {
    expect(isEscalationEnabled({ GEMINI_ESCALATION_ENABLED: undefined })).toBe(false);
    expect(isEscalationEnabled({ GEMINI_ESCALATION_ENABLED: 'false' })).toBe(false);
    expect(isEscalationEnabled({ GEMINI_ESCALATION_ENABLED: '1' })).toBe(false);
    expect(isEscalationEnabled({ GEMINI_ESCALATION_ENABLED: 'TRUE' })).toBe(false);
    expect(isEscalationEnabled({ GEMINI_ESCALATION_ENABLED: 'true' })).toBe(true);
  });

  it('defaults the daily limit to zero when unset', () => {
    expect(getEscalationDailyLimit({ GEMINI_ESCALATION_DAILY_LIMIT: undefined })).toBe(0);
  });

  it('rejects malformed, negative, and fractional budgets as zero, not as unbounded', () => {
    expect(getEscalationDailyLimit({ GEMINI_ESCALATION_DAILY_LIMIT: 'abc' })).toBe(0);
    expect(getEscalationDailyLimit({ GEMINI_ESCALATION_DAILY_LIMIT: '-1' })).toBe(0);
    expect(getEscalationDailyLimit({ GEMINI_ESCALATION_DAILY_LIMIT: '1.5' })).toBe(0);
    expect(getEscalationDailyLimit({ GEMINI_ESCALATION_DAILY_LIMIT: '' })).toBe(0);
  });

  it('accepts a valid in-range budget', () => {
    expect(getEscalationDailyLimit({ GEMINI_ESCALATION_DAILY_LIMIT: '1' })).toBe(1);
    expect(getEscalationDailyLimit({ GEMINI_ESCALATION_DAILY_LIMIT: '2' })).toBe(2);
  });

  it('clamps an excessive configured budget to the hard ceiling, never raising it', () => {
    expect(getEscalationDailyLimit({ GEMINI_ESCALATION_DAILY_LIMIT: '3' })).toBe(ESCALATION_HARD_MAX_PER_DAY);
    expect(getEscalationDailyLimit({ GEMINI_ESCALATION_DAILY_LIMIT: '1000000' })).toBe(ESCALATION_HARD_MAX_PER_DAY);
    expect(ESCALATION_HARD_MAX_PER_DAY).toBe(2);
  });

  it('only event_brief, narrative_delta, and claim_comparison are escalation-eligible', () => {
    expect(ESCALATION_ELIGIBLE_TASKS).toEqual(['event_brief', 'narrative_delta', 'claim_comparison']);
    expect(ESCALATION_ELIGIBLE_TASKS).not.toContain('enrichment');
    expect(ESCALATION_ELIGIBLE_TASKS).not.toContain('event_match');
    expect(ESCALATION_ELIGIBLE_TASKS).not.toContain('community_signal');
  });
});

describe('gemini-escalation: pacificBucketDate', () => {
  it('selects the correct Pacific calendar date at and just before midnight', () => {
    // 2024-01-02T08:00:00Z is 2024-01-02T00:00:00 PST (UTC-8 in January).
    expect(pacificBucketDate(Date.UTC(2024, 0, 2, 8, 0, 0))).toBe('2024-01-02');
    // One minute earlier is still 2024-01-01 in Pacific time.
    expect(pacificBucketDate(Date.UTC(2024, 0, 2, 7, 59, 0))).toBe('2024-01-01');
  });
});

describe('gemini-escalation: failure-eligibility classification', () => {
  const route = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'] as const;

  it('is eligible when every route model failed with invalid_output and all were attempted', () => {
    const attempts: AttemptRecord[] = [
      { model: 'gemini-3.5-flash-lite', outcome: 'failed', classification: 'invalid_output' },
      { model: 'gemini-3.1-flash-lite', outcome: 'failed', classification: 'invalid_output' },
    ];
    expect(isEscalationEligibleFailure(attempts, route)).toBe(true);
  });

  it('is ineligible with no attempts at all', () => {
    expect(isEscalationEligibleFailure([], route)).toBe(false);
    expect(isEscalationEligibleFailure(undefined, route)).toBe(false);
  });

  it('is ineligible when a route model was skipped via an active cooldown', () => {
    const attempts: AttemptRecord[] = [
      { model: 'gemini-3.5-flash-lite', outcome: 'skipped_cooldown', classification: 'daily_quota', cooldown_until: 1 },
      { model: 'gemini-3.1-flash-lite', outcome: 'failed', classification: 'invalid_output' },
    ];
    expect(isEscalationEligibleFailure(attempts, route)).toBe(false);
  });

  it('is ineligible when any attempt failed for a quota/rate-limit/server/access/config reason', () => {
    for (const classification of ['daily_quota', 'rate_limit', 'quota_unknown', 'server', 'access_denied', 'model_not_found', 'invalid_request'] as const) {
      const attempts: AttemptRecord[] = [
        { model: 'gemini-3.5-flash-lite', outcome: 'failed', classification },
        { model: 'gemini-3.1-flash-lite', outcome: 'failed', classification: 'invalid_output' },
      ];
      expect(isEscalationEligibleFailure(attempts, route)).toBe(false);
    }
  });

  it('is ineligible when not every route model was actually attempted', () => {
    const attempts: AttemptRecord[] = [
      { model: 'gemini-3.5-flash-lite', outcome: 'failed', classification: 'invalid_output' },
    ];
    expect(isEscalationEligibleFailure(attempts, route)).toBe(false);
  });

  it('is ineligible when a failure classifies as "unknown" (generic Error/TypeError/DB error), even if every model was attempted', () => {
    const attempts: AttemptRecord[] = [
      { model: 'gemini-3.5-flash-lite', outcome: 'failed', classification: 'unknown' },
      { model: 'gemini-3.1-flash-lite', outcome: 'failed', classification: 'unknown' },
    ];
    expect(isEscalationEligibleFailure(attempts, route)).toBe(false);
  });
});

describe('gemini-escalation: classifyGeminiFailure only treats GeminiOutputValidationError as invalid_output', () => {
  it('classifies GeminiOutputValidationError (the explicit marker) as invalid_output', () => {
    expect(classifyGeminiFailure(new GeminiOutputValidationError('Invalid JSON returned by Gemini API')).classification).toBe('invalid_output');
  });

  it('classifies a generic Error, a TypeError, a DB error, and a non-Error value as "unknown", never invalid_output', () => {
    expect(classifyGeminiFailure(genericErrorOf()).classification).toBe('unknown');
    expect(classifyGeminiFailure(typeErrorOf()).classification).toBe('unknown');
    expect(classifyGeminiFailure(new FakeDatabaseError()).classification).toBe('unknown');
    expect(classifyGeminiFailure('not even an Error object').classification).toBe('unknown');
  });
});

describe('gemini-escalation: atomic daily budget reservation (real local D1)', () => {
  it('the first reservation succeeds and persists a row with count 1', async () => {
    const ok = await reserveEscalationBudget(workerEnv as unknown as Env, ESCALATION_MODEL, 2, Date.UTC(2024, 0, 2, 8, 0, 0));
    expect(ok).toBe(true);
    const rows = await budgetRows();
    expect(rows).toEqual([expect.objectContaining({ bucket_date: '2024-01-02', model: ESCALATION_MODEL, reserved_count: 1 })]);
  });

  it('cannot exceed the configured cap: the 3rd reservation of the day is refused', async () => {
    const now = Date.UTC(2024, 0, 2, 8, 0, 0);
    expect(await reserveEscalationBudget(workerEnv as unknown as Env, ESCALATION_MODEL, 2, now)).toBe(true);
    expect(await reserveEscalationBudget(workerEnv as unknown as Env, ESCALATION_MODEL, 2, now)).toBe(true);
    expect(await reserveEscalationBudget(workerEnv as unknown as Env, ESCALATION_MODEL, 2, now)).toBe(false);
    // A 4th attempt (e.g. a retry) also stays refused — it never reserves unlimited extra calls.
    expect(await reserveEscalationBudget(workerEnv as unknown as Env, ESCALATION_MODEL, 2, now)).toBe(false);
  });

  it('a reservation is consumed even though the call that follows it was never made (no refunds)', async () => {
    const now = Date.UTC(2024, 0, 2, 8, 0, 0);
    await reserveEscalationBudget(workerEnv as unknown as Env, ESCALATION_MODEL, 2, now);
    const rows = await budgetRows();
    expect(rows[0].reserved_count).toBe(1);
  });

  it('concurrent reservations cannot exceed the cap, and refused reservations never increment the stored count', async () => {
    const now = Date.UTC(2024, 0, 2, 8, 0, 0);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => reserveEscalationBudget(workerEnv as unknown as Env, ESCALATION_MODEL, 2, now))
    );
    expect(results.filter(Boolean).length).toBe(2);
    expect(results.filter((r) => !r).length).toBe(3);
    const rows = await budgetRows();
    // The 3 refused attempts must never have touched reserved_count: it stops exactly at the cap.
    expect(rows[0].reserved_count).toBe(2);
  });

  it('Pacific midnight starts a fresh bucket even though the previous day is exhausted', async () => {
    const lateJan1 = Date.UTC(2024, 0, 2, 7, 59, 0); // 2024-01-01 23:59 PST
    await reserveEscalationBudget(workerEnv as unknown as Env, ESCALATION_MODEL, 2, lateJan1);
    await reserveEscalationBudget(workerEnv as unknown as Env, ESCALATION_MODEL, 2, lateJan1);
    expect(await reserveEscalationBudget(workerEnv as unknown as Env, ESCALATION_MODEL, 2, lateJan1)).toBe(false);

    const justAfterMidnight = Date.UTC(2024, 0, 2, 8, 0, 0); // 2024-01-02 00:00 PST
    expect(await reserveEscalationBudget(workerEnv as unknown as Env, ESCALATION_MODEL, 2, justAfterMidnight)).toBe(true);

    const rows = await budgetRows();
    // The refused 3rd attempt on 2024-01-01 must not have incremented that day's count.
    expect(rows).toEqual([
      expect.objectContaining({ bucket_date: '2024-01-01', reserved_count: 2 }),
      expect.objectContaining({ bucket_date: '2024-01-02', reserved_count: 1 }),
    ]);
  });

  it('a budget of zero never reserves, with no DB call needed', async () => {
    expect(await reserveEscalationBudget(workerEnv as unknown as Env, ESCALATION_MODEL, 0, Date.now())).toBe(false);
    expect(await budgetRows()).toEqual([]);
  });

  it('rejects invalid limits itself, independently of the caller, without creating or touching any row', async () => {
    const now = Date.now();
    const invalidLimits = [
      0, -1, -2,
      1.5, 2.5,
      Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
      ESCALATION_HARD_MAX_PER_DAY + 1, 100,
    ];
    for (const limit of invalidLimits) {
      expect(await reserveEscalationBudget(workerEnv as unknown as Env, ESCALATION_MODEL, limit, now)).toBe(false);
    }
    // None of the above should have inserted or updated a budget row.
    expect(await budgetRows()).toEqual([]);
  });

  it('still accepts every valid limit up to and including the hard ceiling', async () => {
    expect(await reserveEscalationBudget(workerEnv as unknown as Env, ESCALATION_MODEL, 1, Date.now())).toBe(true);
    expect(await reserveEscalationBudget(workerEnv as unknown as Env, ESCALATION_MODEL, ESCALATION_HARD_MAX_PER_DAY, Date.now())).toBe(true);
  });

  it('fails closed without throwing when the budget table does not exist', async () => {
    await DB.prepare('DROP TABLE gemini_escalation_budget').run();
    await expect(reserveEscalationBudget(workerEnv as unknown as Env, ESCALATION_MODEL, 2, Date.now())).resolves.toBe(false);
  });
});

describe('gemini-escalation: runGeminiTaskWithEscalation', () => {
  it('is disabled by default: an otherwise-eligible invalid_output failure is not escalated', async () => {
    const env = makeEnv(); // GEMINI_ESCALATION_ENABLED unset
    const attempt = vi.fn().mockRejectedValue(invalidOutputError());

    const error = await runGeminiTaskWithEscalation(env, 'event_brief', attempt, makeDeps()).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(attempt).not.toHaveBeenCalledWith(ESCALATION_MODEL);
    expect(await budgetRows()).toEqual([]);
  });

  it('enabled but unconfigured (limit 0 by default) does not escalate', async () => {
    const env = makeEnv({ GEMINI_ESCALATION_ENABLED: 'true' });
    const attempt = vi.fn().mockRejectedValue(invalidOutputError());

    await expect(runGeminiTaskWithEscalation(env, 'event_brief', attempt, makeDeps())).rejects.toThrow();
    expect(attempt).not.toHaveBeenCalledWith(ESCALATION_MODEL);
  });

  it('a malformed configured budget does not escalate', async () => {
    const env = makeEnv({ GEMINI_ESCALATION_ENABLED: 'true', GEMINI_ESCALATION_DAILY_LIMIT: 'not-a-number' });
    const attempt = vi.fn().mockRejectedValue(invalidOutputError());

    await expect(runGeminiTaskWithEscalation(env, 'event_brief', attempt, makeDeps())).rejects.toThrow();
    expect(attempt).not.toHaveBeenCalledWith(ESCALATION_MODEL);
  });

  it('only the three eligible task types can escalate; enrichment never does even with identical failure shape', async () => {
    const env = makeEnv({ GEMINI_ESCALATION_ENABLED: 'true', GEMINI_ESCALATION_DAILY_LIMIT: '2' });
    const attempt = vi.fn().mockRejectedValue(invalidOutputError());

    await expect(runGeminiTaskWithEscalation(env, 'enrichment', attempt, makeDeps())).rejects.toThrow();
    expect(attempt).not.toHaveBeenCalledWith(ESCALATION_MODEL);
    expect(await budgetRows()).toEqual([]);
  });

  it('valid Lite output succeeds without ever touching 3.6 or the budget', async () => {
    const env = makeEnv({ GEMINI_ESCALATION_ENABLED: 'true', GEMINI_ESCALATION_DAILY_LIMIT: '2' });
    const attempt = vi.fn().mockResolvedValue('ok');

    const result = await runGeminiTaskWithEscalation(env, 'event_brief', attempt, makeDeps());
    expect(result).toMatchObject({ value: 'ok', model: 'gemini-3.5-flash-lite', escalated: false });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(await budgetRows()).toEqual([]);
  });

  it('quota exhaustion on every Lite model never triggers escalation', async () => {
    const env = makeEnv({ GEMINI_ESCALATION_ENABLED: 'true', GEMINI_ESCALATION_DAILY_LIMIT: '2' });
    const attempt = vi.fn().mockImplementation(async (model: string) => { throw dailyQuotaError(model); });

    await expect(runGeminiTaskWithEscalation(env, 'event_brief', attempt, makeDeps())).rejects.toThrow();
    expect(attempt).not.toHaveBeenCalledWith(ESCALATION_MODEL);
    expect(await budgetRows()).toEqual([]);
  });

  it('rate-limit errors never trigger escalation', async () => {
    const env = makeEnv({ GEMINI_ESCALATION_ENABLED: 'true', GEMINI_ESCALATION_DAILY_LIMIT: '2' });
    const attempt = vi.fn().mockImplementation(async (model: string) => { throw rateLimitError(model); });

    await expect(runGeminiTaskWithEscalation(env, 'event_brief', attempt, makeDeps())).rejects.toThrow();
    expect(attempt).not.toHaveBeenCalledWith(ESCALATION_MODEL);
    expect(await budgetRows()).toEqual([]);
  });

  it('server/network errors never trigger escalation', async () => {
    const env = makeEnv({ GEMINI_ESCALATION_ENABLED: 'true', GEMINI_ESCALATION_DAILY_LIMIT: '2' });
    const attempt = vi.fn().mockImplementation(async (model: string) => { throw serverErrorOf(model); });

    await expect(runGeminiTaskWithEscalation(env, 'event_brief', attempt, makeDeps())).rejects.toThrow();
    expect(attempt).not.toHaveBeenCalledWith(ESCALATION_MODEL);
    expect(await budgetRows()).toEqual([]);
  });

  it('invalid_request / access_denied / model_not_found never trigger escalation', async () => {
    const env = makeEnv({ GEMINI_ESCALATION_ENABLED: 'true', GEMINI_ESCALATION_DAILY_LIMIT: '2' });

    for (const errorFactory of [invalidRequestErrorOf, accessDeniedErrorOf, modelNotFoundErrorOf]) {
      const attempt = vi.fn().mockImplementation(async (model: string) => { throw errorFactory(model); });
      await expect(runGeminiTaskWithEscalation(env, 'event_brief', attempt, makeDeps())).rejects.toThrow();
      expect(attempt).not.toHaveBeenCalledWith(ESCALATION_MODEL);
    }
    expect(await budgetRows()).toEqual([]);
  });

  it('a generic Error or TypeError thrown by every Lite attempt never triggers escalation', async () => {
    const env = makeEnv({ GEMINI_ESCALATION_ENABLED: 'true', GEMINI_ESCALATION_DAILY_LIMIT: '2' });

    for (const errorFactory of [genericErrorOf, typeErrorOf]) {
      const attempt = vi.fn().mockRejectedValue(errorFactory());
      await expect(runGeminiTaskWithEscalation(env, 'event_brief', attempt, makeDeps())).rejects.toThrow();
      expect(attempt).not.toHaveBeenCalledWith(ESCALATION_MODEL);
    }
    expect(await budgetRows()).toEqual([]);
  });

  it('an unrelated database/internal error thrown by every Lite attempt never triggers escalation', async () => {
    const env = makeEnv({ GEMINI_ESCALATION_ENABLED: 'true', GEMINI_ESCALATION_DAILY_LIMIT: '2' });
    const attempt = vi.fn().mockRejectedValue(new FakeDatabaseError());

    await expect(runGeminiTaskWithEscalation(env, 'event_brief', attempt, makeDeps())).rejects.toThrow();
    expect(attempt).not.toHaveBeenCalledWith(ESCALATION_MODEL);
    expect(await budgetRows()).toEqual([]);
  });

  it('a mixed history of a genuine validation failure plus a generic/DB error on the other model does not qualify', async () => {
    const env = makeEnv({ GEMINI_ESCALATION_ENABLED: 'true', GEMINI_ESCALATION_DAILY_LIMIT: '2' });
    const attempt = vi.fn().mockImplementation(async (model: string) => {
      if (model === 'gemini-3.5-flash-lite') throw invalidOutputError();
      throw new FakeDatabaseError();
    });

    await expect(runGeminiTaskWithEscalation(env, 'event_brief', attempt, makeDeps())).rejects.toThrow();
    expect(attempt).not.toHaveBeenCalledWith(ESCALATION_MODEL);
    expect(await budgetRows()).toEqual([]);
  });

  it('escalates when every eligible Lite model failed with invalid_output and budget is available', async () => {
    const env = makeEnv({ GEMINI_ESCALATION_ENABLED: 'true', GEMINI_ESCALATION_DAILY_LIMIT: '2' });
    const attempt = vi.fn().mockImplementation(async (model: string) => {
      if (model === ESCALATION_MODEL) return 'escalated-ok';
      throw invalidOutputError();
    });

    const result = await runGeminiTaskWithEscalation(env, 'event_brief', attempt, makeDeps());
    expect(result).toMatchObject({ value: 'escalated-ok', model: ESCALATION_MODEL, escalated: true });
    expect(attempt).toHaveBeenCalledTimes(3); // 2 Lite attempts + 1 escalation attempt
    const rows = await budgetRows();
    expect(rows).toEqual([expect.objectContaining({ model: ESCALATION_MODEL, reserved_count: 1 })]);
  });

  it('a mixed failure history (one model invalid_output, the other quota-limited) prevents escalation', async () => {
    const env = makeEnv({ GEMINI_ESCALATION_ENABLED: 'true', GEMINI_ESCALATION_DAILY_LIMIT: '2' });
    const attempt = vi.fn().mockImplementation(async (model: string) => {
      if (model === 'gemini-3.5-flash-lite') throw invalidOutputError();
      throw dailyQuotaError(model);
    });

    await expect(runGeminiTaskWithEscalation(env, 'event_brief', attempt, makeDeps())).rejects.toThrow();
    expect(attempt).not.toHaveBeenCalledWith(ESCALATION_MODEL);
    expect(await budgetRows()).toEqual([]);
  });

  it('invalid 3.6 output remains a failure: it is never accepted merely for coming from the stronger model', async () => {
    const env = makeEnv({ GEMINI_ESCALATION_ENABLED: 'true', GEMINI_ESCALATION_DAILY_LIMIT: '2' });
    const attempt = vi.fn().mockImplementation(async (model: string) => {
      throw invalidOutputError(model === ESCALATION_MODEL ? 'Invalid structure from 3.6' : 'Invalid structure from lite');
    });

    const error = await runGeminiTaskWithEscalation(env, 'event_brief', attempt, makeDeps()).catch((e) => e);
    expect(error.message).toBe('Invalid structure from 3.6');
    // The budget was still reserved and consumed even though the escalation call failed.
    const rows = await budgetRows();
    expect(rows).toEqual([expect.objectContaining({ model: ESCALATION_MODEL, reserved_count: 1 })]);
  });

  it('exhausting the 2-call daily cap blocks a 3rd escalation the same day, across separate tasks', async () => {
    const env = makeEnv({ GEMINI_ESCALATION_ENABLED: 'true', GEMINI_ESCALATION_DAILY_LIMIT: '2' });
    const escalatingAttempt = vi.fn().mockImplementation(async (model: string) => {
      if (model === ESCALATION_MODEL) return 'ok';
      throw invalidOutputError();
    });

    const deps = makeDeps();
    await runGeminiTaskWithEscalation(env, 'event_brief', escalatingAttempt, deps);
    await runGeminiTaskWithEscalation(env, 'narrative_delta', escalatingAttempt, deps);

    // A third eligible failure the same day must fall back to the plain failure, not a 3rd escalation call.
    const thirdAttempt = vi.fn().mockRejectedValue(invalidOutputError());
    await expect(runGeminiTaskWithEscalation(env, 'claim_comparison', thirdAttempt, deps)).rejects.toThrow();
    expect(thirdAttempt).not.toHaveBeenCalledWith(ESCALATION_MODEL);

    const rows = await budgetRows();
    // The refused 3rd escalation must not have incremented the stored count past the cap.
    expect(rows).toEqual([expect.objectContaining({ model: ESCALATION_MODEL, reserved_count: 2 })]);
  });

  it('an operator-selected gemini-3.6-flash route is tried as an ordinary fallback model, never through the escalation budget', async () => {
    const env = makeEnv({
      GEMINI_ESCALATION_ENABLED: 'true',
      GEMINI_ESCALATION_DAILY_LIMIT: '2',
      GEMINI_MODEL_ROUTES: JSON.stringify({ event_brief: ['gemini-3.6-flash'] }),
    });
    const attempt = vi.fn().mockResolvedValue('operator-selected-ok');

    const result = await runGeminiTaskWithEscalation(env, 'event_brief', attempt, makeDeps());
    expect(result).toMatchObject({ value: 'operator-selected-ok', model: 'gemini-3.6-flash', escalated: false });
    // This is direct routing, not automatic escalation: no budget reservation happens.
    expect(await budgetRows()).toEqual([]);
  });

  it('a database error on the budget table blocks escalation without breaking the underlying Lite failure', async () => {
    await DB.prepare('DROP TABLE gemini_escalation_budget').run();
    const env = makeEnv({ GEMINI_ESCALATION_ENABLED: 'true', GEMINI_ESCALATION_DAILY_LIMIT: '2' });
    const attempt = vi.fn().mockRejectedValue(invalidOutputError());

    const error = await runGeminiTaskWithEscalation(env, 'event_brief', attempt, makeDeps()).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(attempt).not.toHaveBeenCalledWith(ESCALATION_MODEL);
  });
});
