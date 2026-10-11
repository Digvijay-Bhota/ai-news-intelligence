import { describe, it, expect, vi } from 'vitest';
import type { EvalCase } from './gemini-quality-eval/harness';
import {
  buildExperimentPlan,
  buildRunLogRecord,
  classifyPairState,
  limitFetchToSingleRequest,
  MAX_EXPERIMENT_REQUESTS,
  outputFileName,
  parseReservationFileName,
  redactKnownSecrets,
  redactUrlForLogging,
  reservationFileName,
  resolveExecutionApiKey,
  runLogFileName,
  wrapFetchForCapture,
  type RunLogRecord,
} from './gemini-quality-eval/runner';
import { GeminiApiError, GeminiOutputValidationError } from '../src/tasks/gemini-errors';

function minimalCase(id: string, task: EvalCase['task'] = 'event_brief'): EvalCase {
  return {
    id,
    task,
    scenario_category: 'test',
    description: 'test',
    event: { title: 't', description: 'd', severity: 'low' },
    articles: [{ id: 1, source_id: 1, source: 's', title: 't', summary: null, raw_content: null, published_at: null }],
    must_preserve_facts: ['x'],
    must_not_invent: ['x'],
    known_ambiguities: ['x'],
    validation_notes: 'x',
  };
}

describe('buildExperimentPlan', () => {
  it('produces exactly cases.length * 2 pairs in deterministic sorted order', () => {
    const cases = [minimalCase('b'), minimalCase('a')];
    const plan = buildExperimentPlan(cases);
    expect(plan).toHaveLength(4);
    expect(plan.map((p) => `${p.case_id}:${p.model}`)).toEqual([
      'a:gemini-3.5-flash-lite',
      'a:gemini-3.6-flash',
      'b:gemini-3.5-flash-lite',
      'b:gemini-3.6-flash',
    ]);
  });

  it('is stable across repeated calls with the same input', () => {
    const cases = [minimalCase('x'), minimalCase('y'), minimalCase('z')];
    expect(buildExperimentPlan(cases)).toEqual(buildExperimentPlan([...cases].reverse()));
  });

  it('throws rather than silently exceeding the 24-request hard cap', () => {
    const cases = Array.from({ length: 13 }, (_, i) => minimalCase(`case-${i}`));
    expect(() => buildExperimentPlan(cases)).toThrow(/exceeding the hard cap/);
  });

  it('exactly matches MAX_EXPERIMENT_REQUESTS for 12 cases', () => {
    const cases = Array.from({ length: 12 }, (_, i) => minimalCase(`case-${i}`));
    expect(buildExperimentPlan(cases)).toHaveLength(MAX_EXPERIMENT_REQUESTS);
  });
});

describe('wrapFetchForCapture', () => {
  it('captures usageMetadata and finishReason without consuming the original response body', async () => {
    const body = JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    });
    const realFetch = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
    let captured: any = null;
    const wrapped = wrapFetchForCapture(realFetch as any, (meta) => (captured = meta));

    const response = await wrapped('https://example.com/?key=secret');
    // The original caller must still be able to read the body after wrapping.
    const parsed = (await response.json()) as any;
    expect(parsed.candidates[0].content.parts[0].text).toBe('{"ok":true}');

    expect(captured.http_status).toBe(200);
    expect(captured.ok).toBe(true);
    expect(captured.finish_reason).toBe('STOP');
    expect(captured.usage_metadata).toEqual({
      prompt_token_count: 10,
      candidates_token_count: 5,
      total_token_count: 15,
    });
    expect(captured.body_parsed).toBe(true);
  });

  it('reports usage_metadata as null (never fabricated) when the body carries none', async () => {
    const body = JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] } }] });
    const realFetch = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
    let captured: any = null;
    const wrapped = wrapFetchForCapture(realFetch as any, (meta) => (captured = meta));
    await wrapped('https://example.com/');
    expect(captured.usage_metadata).toBeNull();
    expect(captured.finish_reason).toBeNull();
  });

  it('handles a non-JSON / unreadable body honestly (body_parsed: false, nothing fabricated)', async () => {
    const realFetch = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }));
    let captured: any = null;
    const wrapped = wrapFetchForCapture(realFetch as any, (meta) => (captured = meta));
    const response = await wrapped('https://example.com/');
    expect(await response.text()).toBe('not json');
    expect(captured.body_parsed).toBe(false);
    expect(captured.usage_metadata).toBeNull();
  });

  it('preserves error-path responses so the real error classifier can still read the body', async () => {
    const errBody = JSON.stringify({ error: { message: 'bad', status: 'RESOURCE_EXHAUSTED' } });
    const realFetch = vi.fn().mockResolvedValue(new Response(errBody, { status: 429 }));
    let captured: any = null;
    const wrapped = wrapFetchForCapture(realFetch as any, (meta) => (captured = meta));
    const response = await wrapped('https://example.com/');
    expect(response.ok).toBe(false);
    const text = await response.text();
    expect(JSON.parse(text).error.status).toBe('RESOURCE_EXHAUSTED');
    expect(captured.http_status).toBe(429);
    expect(captured.ok).toBe(false);
  });
});

describe('limitFetchToSingleRequest', () => {
  it('passes the first request through and rejects every later one without calling the network', async () => {
    const realFetch = vi.fn().mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })));
    const limited = limitFetchToSingleRequest(realFetch as any);

    const first = await limited('https://example.com/a');
    expect(first.status).toBe(200);
    await expect(limited('https://example.com/b')).rejects.toThrow(/second network request/);
    await expect(limited('https://example.com/c')).rejects.toThrow(/second network request/);
    expect(realFetch).toHaveBeenCalledTimes(1);
  });

  it('still counts a first request that failed at the network layer as the one allowed request', async () => {
    const realFetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const limited = limitFetchToSingleRequest(realFetch as any);
    await expect(limited('https://example.com/')).rejects.toThrow('fetch failed');
    await expect(limited('https://example.com/')).rejects.toThrow(/second network request/);
    expect(realFetch).toHaveBeenCalledTimes(1);
  });
});

describe('redactKnownSecrets', () => {
  it('strips an exact secret value even when it is not AIza-shaped or in a key= parameter', () => {
    const out = redactKnownSecrets('upstream said plain-format-secret-123 was rejected', ['plain-format-secret-123']);
    expect(out).not.toContain('plain-format-secret-123');
    expect(out).toContain('[REDACTED]');
  });

  it('ignores empty secrets instead of mangling the text', () => {
    expect(redactKnownSecrets('unchanged text', [''])).toBe('unchanged text');
  });
});

describe('redactUrlForLogging', () => {
  it('strips an API key from a URL', () => {
    const redacted = redactUrlForLogging('https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=AIzaSySecretValueThatIsLong123');
    expect(redacted).not.toContain('AIzaSySecretValueThatIsLong123');
    expect(redacted).toContain('[REDACTED]');
  });
});

describe('buildRunLogRecord', () => {
  const base = {
    experimentId: 'exp-1',
    caseId: 'case-1',
    task: 'event_brief' as const,
    model: 'gemini-3.5-flash-lite' as const,
    reservedAt: '2026-01-01T00:00:00.000Z',
    responseMeta: null,
  };

  it('builds a completed record with no error fields', () => {
    const record = buildRunLogRecord({ ...base, outcome: 'completed', validation: { valid: true, errors: [] } });
    expect(record.outcome).toBe('completed');
    expect(record.error_classification).toBeNull();
    expect(record.error_message).toBeNull();
    expect(record.mechanical_validation).toEqual({ ran: true, valid: true, errors: [] });
  });

  it('classifies a GeminiOutputValidationError as invalid_output and redacts the message', () => {
    const record = buildRunLogRecord({
      ...base,
      outcome: 'failed',
      error: new GeminiOutputValidationError('bad output ?key=AIzaSySecretValueThatIsLong123'),
      validation: { valid: false, errors: ['bad output'] },
    });
    expect(record.outcome).toBe('failed');
    expect(record.error_classification?.classification).toBe('invalid_output');
    expect(record.error_message).not.toContain('AIzaSySecretValueThatIsLong123');
    expect(record.mechanical_validation).toEqual({ ran: true, valid: false, errors: ['bad output'] });
  });

  it('redacts a known secret from every string field, including API-supplied classification fields', () => {
    const secret = 'plain-format-secret-123';
    const error = new GeminiApiError(`Gemini API error: 400 [${secret}]`, {
      httpStatus: 400,
      apiStatus: secret,
      reason: null,
      quotaIds: [`quota-${secret}`],
      retryAfterSeconds: null,
      safeMessage: null,
      model: 'gemini-3.5-flash-lite',
    });
    const record = buildRunLogRecord({ ...base, outcome: 'failed', error, secrets: [secret] });
    expect(JSON.stringify(record)).not.toContain(secret);
    expect(record.error_classification?.httpStatus).toBe(400);
    expect(record.error_classification?.apiStatus).toBe('[REDACTED]');
  });

  it('classifies an unrelated error as unknown, never fabricating a validation result', () => {
    const record = buildRunLogRecord({ ...base, outcome: 'failed', error: new Error('network boom') });
    expect(record.error_classification?.classification).toBe('unknown');
    expect(record.mechanical_validation).toEqual({ ran: false, valid: null, errors: [] });
  });
});

describe('resolveExecutionApiKey', () => {
  it('requires GEMINI_QUALITY_EVAL_API_KEY and never falls back to GEMINI_API_KEY', () => {
    const result = resolveExecutionApiKey({ GEMINI_API_KEY: 'prod-key' });
    expect(result.ok).toBe(false);
  });

  it('succeeds when the dedicated key is present', () => {
    const result = resolveExecutionApiKey({ GEMINI_QUALITY_EVAL_API_KEY: 'eval-key', GEMINI_API_KEY: 'prod-key' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.key).toBe('eval-key');
  });

  it('rejects an empty/whitespace-only dedicated key', () => {
    expect(resolveExecutionApiKey({ GEMINI_QUALITY_EVAL_API_KEY: '   ' }).ok).toBe(false);
    expect(resolveExecutionApiKey({}).ok).toBe(false);
  });
});

describe('filename conventions and pair-state classification', () => {
  it('round-trips reservation filenames for every model', () => {
    for (const model of ['gemini-3.5-flash-lite', 'gemini-3.6-flash'] as const) {
      const name = reservationFileName('some-case-id', model);
      expect(parseReservationFileName(name)).toEqual({ caseId: 'some-case-id', model });
    }
  });

  it('reuses the existing <case>.<model>.json output convention', () => {
    expect(outputFileName('case-1', 'gemini-3.6-flash')).toBe('case-1.gemini-3.6-flash.json');
  });

  it('produces a distinct run-log filename from the output filename', () => {
    expect(runLogFileName('case-1', 'gemini-3.6-flash')).toBe('case-1.gemini-3.6-flash.run.json');
  });

  it('returns null for a filename that does not parse as a reservation', () => {
    expect(parseReservationFileName('not-a-reservation-file')).toBeNull();
    expect(parseReservationFileName('case-1.unknown-model.reserved')).toBeNull();
  });

  it('classifies pair state from reservation/run-log presence', () => {
    expect(classifyPairState(false, null)).toBe('not_attempted');
    expect(classifyPairState(true, null)).toBe('ambiguous');
    const completed: RunLogRecord = {
      experiment_id: 'e', case_id: 'c', task: 'event_brief', model: 'gemini-3.5-flash-lite',
      reserved_at: '', recorded_at: '', outcome: 'completed', response_meta: null,
      error_classification: null, error_message: null,
      mechanical_validation: { ran: true, valid: true, errors: [] },
    };
    expect(classifyPairState(true, completed)).toBe('completed');
    expect(classifyPairState(true, { ...completed, outcome: 'failed' })).toBe('failed');
  });
});
