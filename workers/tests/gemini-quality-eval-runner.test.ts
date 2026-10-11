import { describe, it, expect, vi } from 'vitest';
import { buildComparisonReport, renderReport, type EvalCase } from './gemini-quality-eval/harness';
import {
  buildExperimentPlan,
  buildRunLogRecord,
  classifyPairState,
  limitFetchToSingleRequest,
  MAX_EXPERIMENT_REQUESTS,
  outputFileName,
  parseReservationFileName,
  parseRunLogRecord,
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

  const SHA = 'ab'.repeat(32);

  it('builds a completed record with no error fields and the output SHA-256', () => {
    const record = buildRunLogRecord({ ...base, outcome: 'completed', validation: { valid: true, errors: [] }, outputSha256: SHA });
    expect(record.outcome).toBe('completed');
    expect(record.error_classification).toBeNull();
    expect(record.error_message).toBeNull();
    expect(record.mechanical_validation).toEqual({ ran: true, valid: true, errors: [] });
    expect(record.output_sha256).toBe(SHA);
    expect(record.reconciled).toBe(false);
  });

  it('refuses a completed record without a valid SHA-256, and a failed record with one', () => {
    expect(() => buildRunLogRecord({ ...base, outcome: 'completed' })).toThrow(/requires an output SHA-256/);
    expect(() => buildRunLogRecord({ ...base, outcome: 'completed', outputSha256: 'xyz' })).toThrow(/requires an output SHA-256/);
    expect(() => buildRunLogRecord({ ...base, outcome: 'failed', error: new Error('x'), outputSha256: SHA })).toThrow(/must not carry/);
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

  const SHA = 'cd'.repeat(32);
  const completed: RunLogRecord = {
    experiment_id: 'e', case_id: 'c', task: 'event_brief', model: 'gemini-3.5-flash-lite',
    reserved_at: '', recorded_at: '', outcome: 'completed', response_meta: null,
    error_classification: null, error_message: null,
    mechanical_validation: { ran: true, valid: true, errors: [] },
    output_sha256: SHA, reconciled: false,
  };
  const failedLog: RunLogRecord = { ...completed, outcome: 'failed', output_sha256: null };
  const valid = (record: RunLogRecord) => ({ status: 'valid' as const, record });
  const absent = { status: 'absent' as const };

  it('classifies every state the write order can produce', () => {
    const state = (reserved: boolean, runLog: Parameters<typeof classifyPairState>[0]['runLog'], sha: string | null) =>
      classifyPairState({ reserved, runLog, canonicalOutputSha256: sha }).state;
    expect(state(false, absent, null)).toBe('not_attempted');
    expect(state(true, absent, null)).toBe('ambiguous');
    expect(state(true, absent, SHA)).toBe('incomplete');
    expect(state(true, valid(completed), SHA)).toBe('completed');
    expect(state(true, valid(failedLog), null)).toBe('failed');
  });

  it('classifies every impossible or mismatched combination as corrupt, with the reason', () => {
    const problem = (reserved: boolean, runLog: Parameters<typeof classifyPairState>[0]['runLog'], sha: string | null) => {
      const r = classifyPairState({ reserved, runLog, canonicalOutputSha256: sha });
      expect(r.state).toBe('corrupt');
      return r.problem;
    };
    expect(problem(true, valid(completed), 'ef'.repeat(32))).toMatch(/does not match/);
    expect(problem(true, valid(completed), null)).toMatch(/canonical output is missing/);
    expect(problem(true, valid(failedLog), SHA)).toMatch(/output exists for a failed run/);
    expect(problem(false, valid(failedLog), null)).toMatch(/run-log exists without a reservation/);
    expect(problem(false, absent, SHA)).toMatch(/canonical output exists without a reservation/);
    expect(problem(true, { status: 'invalid', error: 'boom' }, null)).toMatch(/unreadable: boom/);
  });

  it('parses run-logs strictly for the exact pair', () => {
    expect(parseRunLogRecord(completed, 'c', 'gemini-3.5-flash-lite')).toEqual({ ok: true, record: completed });
    expect(parseRunLogRecord(failedLog, 'c', 'gemini-3.5-flash-lite').ok).toBe(true);
    expect(parseRunLogRecord(completed, 'other', 'gemini-3.5-flash-lite').ok).toBe(false);
    expect(parseRunLogRecord(completed, 'c', 'gemini-3.6-flash').ok).toBe(false);
    expect(parseRunLogRecord({ ...completed, output_sha256: 'short' }, 'c', 'gemini-3.5-flash-lite').ok).toBe(false);
    expect(parseRunLogRecord({ ...failedLog, output_sha256: SHA }, 'c', 'gemini-3.5-flash-lite').ok).toBe(false);
    expect(parseRunLogRecord({ ...completed, outcome: 'pending' }, 'c', 'gemini-3.5-flash-lite').ok).toBe(false);
    expect(parseRunLogRecord([], 'c', 'gemini-3.5-flash-lite').ok).toBe(false);
  });
});

describe('buildComparisonReport with ledger-explained unavailable outputs', () => {
  it('keeps failed/ambiguous/incomplete/corrupt distinct from missing, and never as valid', () => {
    const cases = [minimalCase('a'), minimalCase('b'), minimalCase('c')];
    const why = {
      'a:gemini-3.5-flash-lite': { status: 'failed' as const, detail: 'request failed (server)' },
      'a:gemini-3.6-flash': { status: 'ambiguous' as const, detail: null },
      'b:gemini-3.5-flash-lite': { status: 'incomplete' as const, detail: null },
      'b:gemini-3.6-flash': { status: 'corrupt_output' as const, detail: 'hash mismatch' },
    } as Record<string, { status: 'failed' | 'ambiguous' | 'incomplete' | 'corrupt_output'; detail: string | null }>;
    const results = buildComparisonReport(
      cases,
      () => null,
      () => ({ status: 'none' }),
      (caseId, model) => why[`${caseId}:${model}`] ?? { status: 'missing', detail: null }
    );
    expect(results.map((r) => r.status)).toEqual(['failed', 'ambiguous', 'incomplete', 'corrupt_output', 'missing', 'missing']);
    expect(results[0].output_detail).toBe('request failed (server)');
    expect(results[4]).not.toHaveProperty('output_detail');
    const text = renderReport(cases, results);
    expect(text).toContain('ledger: hash mismatch');
    expect(text).toMatch(/2 missing, .*1 failed, 1 ambiguous, 1 incomplete, 1 corrupt_output\.$/);
  });

  it('without the optional callback behaves exactly as before (all missing)', () => {
    const results = buildComparisonReport([minimalCase('a')], () => null, () => ({ status: 'none' }));
    expect(results.map((r) => r.status)).toEqual(['missing', 'missing']);
    expect(renderReport([minimalCase('a')], results)).toMatch(/0 corrupt_score\.$/);
  });
});
