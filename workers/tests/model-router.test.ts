import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ALLOWED_MODELS,
  DEFAULT_ROUTES,
  GeminiDeferredError,
  MAX_ATTEMPTS_PER_MODEL,
  MAX_ATTEMPTS_PER_TASK,
  attemptsMetadata,
  getCooldown,
  getModelRoute,
  resetModelRouterMemory,
  runGeminiTask,
  secondsUntilDailyReset,
  setCooldown,
  type RouterDeps,
} from '../src/tasks/model-router';
import { GeminiApiError } from '../src/tasks/gemini-errors';
import { createMockEnv, createMockKVNamespace } from './setup';
import type { Env } from '../src/types';

function makeEnv(overrides: Partial<Env> = {}) {
  return createMockEnv({ CACHE: createMockKVNamespace(), ...overrides });
}

/** Deterministic deps: no real waiting, fixed clock (mutable), no jitter. */
function makeDeps(startMs = 1_700_000_000_000): RouterDeps & { advance: (ms: number) => void } {
  let now = startMs;
  return {
    nowMs: () => now,
    sleep: vi.fn().mockResolvedValue(undefined),
    random: () => 0,
    advance: (ms: number) => { now += ms; },
  };
}

function apiError(status: number, body: Record<string, unknown> = {}, model = 'm'): GeminiApiError {
  // Mirrors the shape geminiErrorFromResponse would have classified already parsed fields for.
  return new GeminiApiError(`Gemini API error: ${status}`, {
    httpStatus: status,
    apiStatus: (body.apiStatus as string) ?? null,
    reason: (body.reason as string) ?? null,
    quotaIds: (body.quotaIds as string[]) ?? [],
    retryAfterSeconds: (body.retryAfterSeconds as number) ?? null,
    safeMessage: null,
    model,
  });
}

const dailyQuotaError = (model = 'm') =>
  apiError(429, { apiStatus: 'quota_exceeded' }, model);
const rateLimitError = (retryAfterSeconds: number | null, model = 'm') =>
  apiError(429, { apiStatus: 'rate_limit_exceeded', retryAfterSeconds }, model);
const quotaUnknownError = (retryAfterSeconds: number | null = null, model = 'm') =>
  apiError(429, { retryAfterSeconds }, model);
const serverError = (model = 'm') => apiError(500, {}, model);
const accessDeniedError = (model = 'm') => apiError(403, {}, model);
const modelNotFoundError = (model = 'm') => apiError(404, {}, model);
const invalidRequestError = (model = 'm') => apiError(400, {}, model);
const invalidOutputError = () => new Error('Invalid structure: summary must be a string');

beforeEach(() => {
  resetModelRouterMemory();
});

describe('model-router: getModelRoute', () => {
  it('uses the free-tier Flash-Lite chain, in order, for every task by default', () => {
    const env = makeEnv();
    for (const task of Object.keys(DEFAULT_ROUTES) as (keyof typeof DEFAULT_ROUTES)[]) {
      expect(getModelRoute(env, task)).toEqual(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
    }
  });

  it('applies a valid GEMINI_MODEL_ROUTES override for the matching task only', () => {
    const env = makeEnv({
      GEMINI_MODEL_ROUTES: JSON.stringify({ event_brief: ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'] }),
    });
    expect(getModelRoute(env, 'event_brief')).toEqual(['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']);
    expect(getModelRoute(env, 'narrative_delta')).toEqual(DEFAULT_ROUTES.narrative_delta);
  });

  it('allows an explicit opt-in to the paid model via override, since it remains in the allowlist', () => {
    const env = makeEnv({ GEMINI_MODEL_ROUTES: JSON.stringify({ event_brief: ['gemini-3.6-flash'] }) });
    expect(getModelRoute(env, 'event_brief')).toEqual(['gemini-3.6-flash']);
  });

  it('drops disallowed model names from an override and falls back to the default route if nothing valid remains', () => {
    const env = makeEnv({ GEMINI_MODEL_ROUTES: JSON.stringify({ event_brief: ['not-a-real-model', 'also-fake'] }) });
    expect(getModelRoute(env, 'event_brief')).toEqual(DEFAULT_ROUTES.event_brief);
  });

  it('filters out disallowed entries from a mixed override but keeps the allowed ones', () => {
    const env = makeEnv({ GEMINI_MODEL_ROUTES: JSON.stringify({ enrichment: ['not-a-real-model', 'gemini-3.1-flash-lite'] }) });
    expect(getModelRoute(env, 'enrichment')).toEqual(['gemini-3.1-flash-lite']);
  });

  it('falls back safely on malformed override JSON without throwing', () => {
    const env = makeEnv({ GEMINI_MODEL_ROUTES: '{not json' });
    expect(() => getModelRoute(env, 'enrichment')).not.toThrow();
    expect(getModelRoute(env, 'enrichment')).toEqual(DEFAULT_ROUTES.enrichment);
  });

  it('every allowlisted model is one of the three stable free/paid-tier models and nothing else', () => {
    expect(ALLOWED_MODELS).toEqual(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash']);
  });
});

describe('model-router: secondsUntilDailyReset', () => {
  it('computes remaining seconds until midnight Pacific time', () => {
    // 2024-01-01T20:00:00Z is 2024-01-01T12:00:00 PST (UTC-8, no DST in January).
    const noonPacific = Date.UTC(2024, 0, 1, 20, 0, 0);
    expect(secondsUntilDailyReset(noonPacific)).toBe(12 * 3600);
  });

  it('returns a small remaining value just before midnight Pacific', () => {
    // 2024-01-02T07:59:00Z is 2024-01-01T23:59:00 PST.
    const almostMidnight = Date.UTC(2024, 0, 2, 7, 59, 0);
    expect(secondsUntilDailyReset(almostMidnight)).toBe(60);
  });
});

describe('model-router: successful runs', () => {
  it('serves from the primary model on first success without touching cooldowns', async () => {
    const env = makeEnv();
    const deps = makeDeps();
    const attempt = vi.fn().mockResolvedValue('ok');

    const result = await runGeminiTask(env, 'enrichment', attempt, deps);

    expect(result.value).toBe('ok');
    expect(result.model).toBe('gemini-3.5-flash-lite');
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledWith('gemini-3.5-flash-lite');
  });

  it('falls back to the next model and reports the model that actually served the request', async () => {
    const env = makeEnv();
    const deps = makeDeps();
    const attempt = vi.fn()
      .mockRejectedValueOnce(dailyQuotaError('gemini-3.5-flash-lite'))
      .mockResolvedValueOnce('fallback-ok');

    const result = await runGeminiTask(env, 'enrichment', attempt, deps);

    expect(result.value).toBe('fallback-ok');
    expect(result.model).toBe('gemini-3.1-flash-lite');
    expect(attempt).toHaveBeenNthCalledWith(1, 'gemini-3.5-flash-lite');
    expect(attempt).toHaveBeenNthCalledWith(2, 'gemini-3.1-flash-lite');
  });
});

describe('model-router: daily quota cooldown', () => {
  it('puts the exhausted model on cooldown until the next Pacific midnight plus a buffer, and records the quota id', async () => {
    const env = makeEnv();
    const noonPacific = Date.UTC(2024, 0, 1, 20, 0, 0);
    const deps = makeDeps(noonPacific);
    const attempt = vi.fn()
      .mockRejectedValueOnce(apiError(429, { apiStatus: 'quota_exceeded', quotaIds: ['GenerateContentPerDayPerProjectPerModel'] }, 'gemini-3.5-flash-lite'))
      .mockResolvedValueOnce('ok');

    await runGeminiTask(env, 'enrichment', attempt, deps);

    const cooldown = await getCooldown(env, 'gemini-3.5-flash-lite', Math.floor(noonPacific / 1000));
    expect(cooldown).not.toBeNull();
    expect(cooldown!.reason).toBe('daily_quota');
    expect(cooldown!.until).toBe(Math.floor(noonPacific / 1000) + 12 * 3600 + 300);
    expect(cooldown!.quota_ids).toEqual(['GenerateContentPerDayPerProjectPerModel']);
  });

  it('never exceeds the hard cooldown ceiling even if a computed duration would be longer', async () => {
    const env = makeEnv();
    const now = 1_700_000_000;
    await setCooldown(env, { model: 'gemini-3.5-flash-lite', reason: 'daily_quota', set_at: now, until: now + 1_000_000 });
    const cooldown = await getCooldown(env, 'gemini-3.5-flash-lite', now);
    expect(cooldown!.until - now).toBeLessThanOrEqual(25 * 3600);
  });
});

describe('model-router: cooldowns prevent repeated calls to an unavailable model', () => {
  it('skips a model already in cooldown without calling attempt() for it', async () => {
    const env = makeEnv();
    const deps = makeDeps();
    const now = Math.floor(deps.nowMs() / 1000);
    await setCooldown(env, { model: 'gemini-3.5-flash-lite', reason: 'daily_quota', set_at: now, until: now + 3600 });

    const attempt = vi.fn().mockResolvedValue('ok');
    const result = await runGeminiTask(env, 'enrichment', attempt, deps);

    expect(result.model).toBe('gemini-3.1-flash-lite');
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledWith('gemini-3.1-flash-lite');
  });

  it('defers with zero attempt() calls when every eligible model is already cooling down', async () => {
    const env = makeEnv();
    const deps = makeDeps();
    const now = Math.floor(deps.nowMs() / 1000);
    for (const model of DEFAULT_ROUTES.enrichment) {
      await setCooldown(env, { model, reason: 'daily_quota', set_at: now, until: now + 3600 });
    }

    const attempt = vi.fn().mockResolvedValue('ok');
    await expect(runGeminiTask(env, 'enrichment', attempt, deps)).rejects.toBeInstanceOf(GeminiDeferredError);
    expect(attempt).not.toHaveBeenCalled();
  });
});

describe('model-router: rate limits honor Retry-After only within the inline wait bound', () => {
  it('retries inline on the same model when Retry-After is within the bound', async () => {
    const env = makeEnv();
    const deps = makeDeps();
    const attempt = vi.fn()
      .mockRejectedValueOnce(rateLimitError(5, 'gemini-3.5-flash-lite'))
      .mockResolvedValueOnce('ok');

    const result = await runGeminiTask(env, 'enrichment', attempt, deps);

    expect(result.model).toBe('gemini-3.5-flash-lite');
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(attempt).toHaveBeenNthCalledWith(1, 'gemini-3.5-flash-lite');
    expect(attempt).toHaveBeenNthCalledWith(2, 'gemini-3.5-flash-lite');
    expect(deps.sleep).toHaveBeenCalledTimes(1);
    // retryDelayMs: retryAfterSeconds * 1000 + jitter(0) when random() = 0
    expect(deps.sleep).toHaveBeenCalledWith(5000);
  });

  it('does not wait inline when Retry-After exceeds the inline bound; cools the model down instead', async () => {
    const env = makeEnv();
    const deps = makeDeps();
    const attempt = vi.fn()
      .mockRejectedValueOnce(rateLimitError(3600, 'gemini-3.5-flash-lite'))
      .mockResolvedValueOnce('ok');

    const result = await runGeminiTask(env, 'enrichment', attempt, deps);

    expect(result.model).toBe('gemini-3.1-flash-lite');
    expect(deps.sleep).not.toHaveBeenCalled();
    const cooldown = await getCooldown(env, 'gemini-3.5-flash-lite', Math.floor(deps.nowMs() / 1000));
    expect(cooldown).not.toBeNull();
    expect(cooldown!.reason).toBe('rate_limit');
  });

  it('bounds the rate-limit cooldown to the configured maximum', async () => {
    const env = makeEnv();
    const deps = makeDeps();
    const attempt = vi.fn()
      .mockRejectedValueOnce(rateLimitError(999_999, 'gemini-3.5-flash-lite'))
      .mockResolvedValueOnce('ok');

    const now = Math.floor(deps.nowMs() / 1000);
    await runGeminiTask(env, 'enrichment', attempt, deps);
    const cooldown = await getCooldown(env, 'gemini-3.5-flash-lite', now);
    expect(cooldown!.until - now).toBeLessThanOrEqual(3600);
  });
});

describe('model-router: a 429 with no distinguishing detail (quota_unknown) retries once, then cools down conservatively', () => {
  it('retries inline once on the same model, then falls back on a second failure', async () => {
    const env = makeEnv();
    const deps = makeDeps();
    const attempt = vi.fn()
      .mockRejectedValueOnce(quotaUnknownError(null, 'gemini-3.5-flash-lite'))
      .mockResolvedValueOnce('ok');

    const result = await runGeminiTask(env, 'enrichment', attempt, deps);

    expect(result.model).toBe('gemini-3.5-flash-lite');
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(deps.sleep).toHaveBeenCalledTimes(1);
  });

  it('cools the model down for a conservative minimum when both attempts fail', async () => {
    const env = makeEnv();
    const deps = makeDeps();
    const attempt = vi.fn()
      .mockRejectedValueOnce(quotaUnknownError(null, 'gemini-3.5-flash-lite'))
      .mockRejectedValueOnce(quotaUnknownError(null, 'gemini-3.5-flash-lite'))
      .mockResolvedValueOnce('ok');

    const now = Math.floor(deps.nowMs() / 1000);
    const result = await runGeminiTask(env, 'enrichment', attempt, deps);

    expect(result.model).toBe('gemini-3.1-flash-lite');
    const cooldown = await getCooldown(env, 'gemini-3.5-flash-lite', now);
    expect(cooldown).not.toBeNull();
    expect(cooldown!.reason).toBe('quota_unknown');
    expect(cooldown!.until - now).toBeGreaterThanOrEqual(900);
  });
});

describe('model-router: KV failures fail open instead of crashing routing', () => {
  it('still attempts the model when the KV cooldown read rejects', async () => {
    const env = makeEnv();
    (env.CACHE.get as any) = vi.fn().mockRejectedValue(new Error('KV unavailable'));
    const deps = makeDeps();
    const attempt = vi.fn().mockResolvedValue('ok');

    const result = await runGeminiTask(env, 'enrichment', attempt, deps);
    expect(result.value).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('does not throw when the KV cooldown write rejects; in-memory mirror still protects the model', async () => {
    const env = makeEnv();
    (env.CACHE.put as any) = vi.fn().mockRejectedValue(new Error('KV unavailable'));
    const deps = makeDeps();
    const attempt = vi.fn()
      .mockRejectedValueOnce(dailyQuotaError('gemini-3.5-flash-lite'))
      .mockResolvedValueOnce('ok');

    const result = await runGeminiTask(env, 'enrichment', attempt, deps);
    expect(result.model).toBe('gemini-3.1-flash-lite');

    // Isolate-local mirror still remembers the cooldown even though the KV write failed.
    const cooldown = await getCooldown(env, 'gemini-3.5-flash-lite', Math.floor(deps.nowMs() / 1000));
    expect(cooldown).not.toBeNull();
  });
});

describe('model-router: attempt bounds', () => {
  it('never calls a single model more than MAX_ATTEMPTS_PER_MODEL times', async () => {
    const env = makeEnv();
    const deps = makeDeps();
    // Server errors are retried inline, so this would loop forever without a per-model cap.
    const attempt = vi.fn().mockRejectedValue(serverError('gemini-3.5-flash-lite'));

    await expect(runGeminiTask(env, 'enrichment', attempt, deps)).rejects.toThrow();
    const callsForPrimary = attempt.mock.calls.filter((c) => c[0] === 'gemini-3.5-flash-lite').length;
    expect(callsForPrimary).toBe(MAX_ATTEMPTS_PER_MODEL);
  });

  it('never calls attempt() more than MAX_ATTEMPTS_PER_TASK times across all models combined', async () => {
    const env = makeEnv();
    const deps = makeDeps();
    const attempt = vi.fn().mockRejectedValue(serverError());

    await expect(runGeminiTask(env, 'enrichment', attempt, deps)).rejects.toThrow();
    expect(attempt).toHaveBeenCalledTimes(MAX_ATTEMPTS_PER_TASK);
  });
});

describe('model-router: deferral vs rethrow for non-quota failures', () => {
  it('defers (does not rethrow the raw error) when every model is quota-limited', async () => {
    const env = makeEnv();
    const deps = makeDeps();
    const attempt = vi.fn().mockRejectedValue(dailyQuotaError());

    const error = await runGeminiTask(env, 'enrichment', attempt, deps).catch((e) => e);
    expect(error).toBeInstanceOf(GeminiDeferredError);
    expect((error as InstanceType<typeof GeminiDeferredError>).reason).toBe('models_unavailable');
  });

  it('access_denied defers immediately with no fallback to the next model', async () => {
    const env = makeEnv();
    const deps = makeDeps();
    const attempt = vi.fn().mockRejectedValue(accessDeniedError('gemini-3.5-flash-lite'));

    const error = await runGeminiTask(env, 'enrichment', attempt, deps).catch((e) => e);
    expect(error).toBeInstanceOf(GeminiDeferredError);
    expect((error as InstanceType<typeof GeminiDeferredError>).reason).toBe('access_denied');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('model_not_found defers immediately with no fallback to the next model', async () => {
    const env = makeEnv();
    const deps = makeDeps();
    const attempt = vi.fn().mockRejectedValue(modelNotFoundError('gemini-3.5-flash-lite'));

    const error = await runGeminiTask(env, 'enrichment', attempt, deps).catch((e) => e);
    expect(error).toBeInstanceOf(GeminiDeferredError);
    expect((error as InstanceType<typeof GeminiDeferredError>).reason).toBe('model_not_found');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('invalid_request rethrows the original error immediately with no fallback', async () => {
    const env = makeEnv();
    const deps = makeDeps();
    const original = invalidRequestError('gemini-3.5-flash-lite');
    const attempt = vi.fn().mockRejectedValue(original);

    const error = await runGeminiTask(env, 'enrichment', attempt, deps).catch((e) => e);
    expect(error).toBe(original);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('invalid_output (validation failure) falls back to the next model instead of deferring', async () => {
    const env = makeEnv();
    const deps = makeDeps();
    const attempt = vi.fn()
      .mockRejectedValueOnce(invalidOutputError())
      .mockResolvedValueOnce('ok');

    const result = await runGeminiTask(env, 'enrichment', attempt, deps);
    expect(result.model).toBe('gemini-3.1-flash-lite');
  });

  it('rethrows the last underlying error (not a GeminiDeferredError) when all models fail with invalid_output', async () => {
    const env = makeEnv();
    const deps = makeDeps();
    const failure = invalidOutputError();
    const attempt = vi.fn().mockRejectedValue(failure);

    const error = await runGeminiTask(env, 'enrichment', attempt, deps).catch((e) => e);
    expect(error).toBe(failure);
    expect(attemptsMetadata('enrichment', error)).toBeDefined();
  });
});

describe('model-router: cooldown state does not leak between tests', () => {
  it('starts with a clean slate thanks to resetModelRouterMemory in beforeEach', async () => {
    const env = makeEnv();
    const deps = makeDeps();
    const cooldown = await getCooldown(env, 'gemini-3.5-flash-lite', Math.floor(deps.nowMs() / 1000));
    expect(cooldown).toBeNull();
  });
});
