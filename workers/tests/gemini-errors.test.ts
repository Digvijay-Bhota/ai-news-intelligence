import { describe, it, expect } from 'vitest';
import {
  classifyGeminiFailure,
  geminiErrorFromResponse,
  geminiNetworkError,
  parseRetryAfter,
  redactSecrets,
  GeminiApiError,
} from '../src/tasks/gemini-errors';
import { ApiError } from '../src/utils/errors';

/** Builds a minimal Response-like object for geminiErrorFromResponse. */
function fakeResponse(opts: {
  status: number;
  statusText?: string;
  body?: unknown;
  headers?: Record<string, string>;
  textThrows?: boolean;
  noHeaders?: boolean;
}): Response {
  const headers = opts.noHeaders
    ? undefined
    : {
        get: (name: string) => opts.headers?.[name] ?? null,
      };
  return {
    ok: false,
    status: opts.status,
    statusText: opts.statusText ?? '',
    headers,
    text: async () => {
      if (opts.textThrows) throw new Error('body read failed');
      return typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body ?? {});
    },
  } as unknown as Response;
}

function quotaFailureBody(quotaId: string, extra: Record<string, unknown> = {}) {
  return {
    error: {
      status: 'RESOURCE_EXHAUSTED',
      message: 'Quota exceeded',
      details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] },
      ],
      ...extra,
    },
  };
}

describe('gemini-errors: redactSecrets', () => {
  it('redacts a key= query parameter', () => {
    const text = 'https://x/y?key=SUPERSECRETVALUE123456&foo=bar';
    expect(redactSecrets(text)).toBe('https://x/y?key=[REDACTED]&foo=bar');
  });

  it('redacts a bare AIza-prefixed API key anywhere in text', () => {
    const key = 'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456';
    const text = `error talking to ${key} failed`;
    expect(redactSecrets(text)).not.toContain(key);
    expect(redactSecrets(text)).toContain('[REDACTED]');
  });
});

describe('gemini-errors: parseRetryAfter', () => {
  it('parses a plain seconds string from RetryInfo', () => {
    expect(parseRetryAfter('43s')).toBe(43);
  });

  it('rounds up a fractional seconds string', () => {
    expect(parseRetryAfter('1.5s')).toBe(2);
  });

  it('parses an HTTP-date Retry-After header relative to now', () => {
    const now = Date.now();
    const future = new Date(now + 5000).toUTCString();
    expect(parseRetryAfter(future, now)).toBe(5);
  });

  it('returns null for empty or unparseable values', () => {
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('not-a-duration')).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe('gemini-errors: geminiErrorFromResponse parsing', () => {
  it('distinguishes a per-day quota failure from a per-minute one via quotaId', async () => {
    const dayErr = await geminiErrorFromResponse(
      fakeResponse({ status: 429, body: quotaFailureBody('GenerateContentPerDayPerProjectPerModel') }),
      'gemini-3.5-flash-lite'
    );
    expect(classifyGeminiFailure(dayErr).classification).toBe('daily_quota');

    const minuteErr = await geminiErrorFromResponse(
      fakeResponse({ status: 429, body: quotaFailureBody('GenerateContentPerMinutePerProjectPerModel') }),
      'gemini-3.5-flash-lite'
    );
    expect(classifyGeminiFailure(minuteErr).classification).toBe('rate_limit');
  });

  it('recognizes snake_case apiStatus codes for day vs rate limits', async () => {
    const dayErr = await geminiErrorFromResponse(
      fakeResponse({ status: 429, body: { error: { status: 'quota_exceeded', message: 'daily cap hit' } } }),
      'm'
    );
    expect(classifyGeminiFailure(dayErr).classification).toBe('daily_quota');

    const rateErr = await geminiErrorFromResponse(
      fakeResponse({ status: 429, body: { error: { status: 'rate_limit_exceeded', message: 'slow down' } } }),
      'm'
    );
    expect(classifyGeminiFailure(rateErr).classification).toBe('rate_limit');
  });

  it('classifies a bare 429 with no distinguishing detail as quota_unknown, not a guessed quota', async () => {
    const err = await geminiErrorFromResponse(fakeResponse({ status: 429, body: {} }), 'm');
    const classified = classifyGeminiFailure(err);
    expect(classified.classification).toBe('quota_unknown');
    expect(classified.quotaIds).toEqual([]);
  });

  it('extracts RetryInfo retryDelay over a Retry-After header', async () => {
    const body = {
      error: {
        status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' }],
      },
    };
    const err = await geminiErrorFromResponse(
      fakeResponse({ status: 429, body, headers: { 'Retry-After': '99' } }),
      'm'
    );
    expect(err.details.retryAfterSeconds).toBe(7);
  });

  it('falls back to the Retry-After header when no RetryInfo is present', async () => {
    const err = await geminiErrorFromResponse(
      fakeResponse({ status: 429, body: {}, headers: { 'Retry-After': '12' } }),
      'm'
    );
    expect(err.details.retryAfterSeconds).toBe(12);
  });

  it('extracts an ErrorInfo reason and treats a known access reason as access_denied regardless of status', async () => {
    const body = {
      error: {
        status: 'INVALID_ARGUMENT',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }],
      },
    };
    const err = await geminiErrorFromResponse(fakeResponse({ status: 400, body }), 'm');
    expect(err.details.reason).toBe('API_KEY_INVALID');
    expect(classifyGeminiFailure(err).classification).toBe('access_denied');
  });

  it('classifies plain HTTP statuses consistently: 401/402/403 access_denied, 404 model_not_found, 400 invalid_request, 5xx/408 server', async () => {
    for (const status of [401, 402, 403]) {
      const err = await geminiErrorFromResponse(fakeResponse({ status, body: {} }), 'm');
      expect(classifyGeminiFailure(err).classification).toBe('access_denied');
    }
    const notFound = await geminiErrorFromResponse(fakeResponse({ status: 404, body: {} }), 'm');
    expect(classifyGeminiFailure(notFound).classification).toBe('model_not_found');

    const badRequest = await geminiErrorFromResponse(fakeResponse({ status: 400, body: {} }), 'm');
    expect(classifyGeminiFailure(badRequest).classification).toBe('invalid_request');

    for (const status of [500, 502, 503, 408, 524]) {
      const err = await geminiErrorFromResponse(fakeResponse({ status, body: {} }), 'm');
      expect(classifyGeminiFailure(err).classification).toBe('server');
    }
  });

  it('classifies a network-level failure (no HTTP response at all) as server', () => {
    const err = geminiNetworkError('gemini-3.5-flash-lite');
    expect(classifyGeminiFailure(err).classification).toBe('server');
    expect(err.details.httpStatus).toBe(0);
  });

  it('classifies a plain ApiError thrown elsewhere in the stack by its HTTP status', () => {
    expect(classifyGeminiFailure(new ApiError(429, 'Rate limit')).classification).toBe('quota_unknown');
    expect(classifyGeminiFailure(new ApiError(500, 'boom')).classification).toBe('server');
  });

  it('classifies a non-API error (e.g. JSON/schema validation failure) as invalid_output', () => {
    expect(classifyGeminiFailure(new Error('Invalid JSON returned by Gemini API')).classification).toBe('invalid_output');
    expect(classifyGeminiFailure('not even an Error object').classification).toBe('invalid_output');
  });

  it('redacts an API key embedded in the upstream error message', async () => {
    const key = 'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456';
    const err = await geminiErrorFromResponse(
      fakeResponse({ status: 400, body: { error: { message: `Request to ...key=${key} failed` } } }),
      'm'
    );
    expect(err.details.safeMessage).not.toContain(key);
    expect(err.message).not.toContain(key);
  });

  it('truncates an overlong safe message instead of storing it unbounded', async () => {
    const longMessage = 'x'.repeat(5000);
    const err = await geminiErrorFromResponse(
      fakeResponse({ status: 400, body: { error: { message: longMessage } } }),
      'm'
    );
    expect(err.details.safeMessage?.length).toBeLessThanOrEqual(300);
  });

  it('never crashes and never exposes body content when the response body cannot be read', async () => {
    const err = await geminiErrorFromResponse(fakeResponse({ status: 500, textThrows: true }), 'm');
    expect(err).toBeInstanceOf(GeminiApiError);
    expect(err.details.apiStatus).toBeNull();
    expect(err.details.safeMessage).toBeNull();
  });

  it('never crashes on a malformed (non-JSON) response body', async () => {
    const err = await geminiErrorFromResponse(fakeResponse({ status: 500, body: '<html>not json</html>' }), 'm');
    expect(err).toBeInstanceOf(GeminiApiError);
    expect(err.details.httpStatus).toBe(500);
  });

  it('never crashes when the response has no headers object at all', async () => {
    const err = await geminiErrorFromResponse(fakeResponse({ status: 429, body: {}, noHeaders: true }), 'm');
    expect(err.details.retryAfterSeconds).toBeNull();
  });

  it('keeps the historical "Gemini API error: <status>" message prefix for retry-budget matching', async () => {
    const err = await geminiErrorFromResponse(fakeResponse({ status: 429, statusText: 'Too Many Requests', body: {} }), 'm');
    expect(err.message).toContain('Gemini API error: 429');
  });
});
