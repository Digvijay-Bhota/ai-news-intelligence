import { describe, it, expect, vi } from 'vitest';
import {
  generateClaimComparisonsFromGemini,
  generateEnrichment,
  generateEventBriefFromGemini,
  generateNarrativeDeltaFromGemini,
  matchEventToCluster,
} from '../src/tasks/gemini';
import claimComparison04 from './gemini-quality-eval/cases/claim-comparison-04-evolving-breaking-situation.json';
import narrativeDelta02 from './gemini-quality-eval/cases/narrative-delta-02-correction-retraction.json';
import { createMockEnv } from './setup';

describe('Gemini Client', () => {
  it('calls Gemini and parses JSON', async () => {
    const env = createMockEnv({ GEMINI_API_KEY: 'test-key' });
    const mockResponse = {
      candidates: [{ content: { parts: [{ text: '{"summary": "test", "topics": ["t1"], "events": []}' }] } }],
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const result = await generateEnrichment(env, 'prompt');
    expect(result.summary).toBe('test');
    expect(result.topics).toEqual(['t1']);
  });

  it('throws on API error', async () => {
    const env = createMockEnv({ GEMINI_API_KEY: 'test-key' });
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' });

    await expect(generateEnrichment(env, 'prompt')).rejects.toThrow('Gemini API error: 500');
  });

  it('strips markdown code blocks and parses JSON', async () => {
    const env = createMockEnv({ GEMINI_API_KEY: 'test-key' });
    const mockResponse = {
      candidates: [{ content: { parts: [{ text: '```json\n{"summary": "test", "topics": ["t1"], "events": []}\n```' }] } }],
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const result = await generateEnrichment(env, 'prompt');
    expect(result.summary).toBe('test');
  });

  it('rejects malformed JSON without leaking content', async () => {
    const env = createMockEnv({ GEMINI_API_KEY: 'test-key' });
    const mockResponse = {
      candidates: [{ content: { parts: [{ text: '{ bad_json }' }] } }],
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    await expect(generateEnrichment(env, 'prompt')).rejects.toThrow('Invalid JSON returned by Gemini API');
  });

  it('matchEventToCluster returns false on empty candidates', async () => {
    const env = createMockEnv();
    const result = await matchEventToCluster(env, { title: 't', description: 'd' }, []);
    expect(result.match).toBe(false);
    expect(result.event_id).toBe(null);
  });

  it('matchEventToCluster returns parsed match result', async () => {
    const env = createMockEnv({ GEMINI_API_KEY: 'test-key' });
    const mockResponse = {
      candidates: [{ content: { parts: [{ text: '{"match": true, "event_id": 123}' }] } }],
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const result = await matchEventToCluster(env, { title: 't', description: 'd' }, [{ id: 123, title: 'Old t', description: 'Old d', severity: 'high' }]);
    expect(result.match).toBe(true);
    expect(result.event_id).toBe(123);
  });

  it('matchEventToCluster throws on invalid json structure', async () => {
    const env = createMockEnv({ GEMINI_API_KEY: 'test-key' });
    const mockResponse = {
      candidates: [{ content: { parts: [{ text: '{"match": "maybe"}' }] } }],
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    await expect(matchEventToCluster(env, { title: 't', description: 'd' }, [{ id: 123, title: 'Old t', description: 'Old d', severity: 'high' }]))
      .rejects.toThrow('Invalid structure: match must be boolean');
  });
});

// Offline prompt-content checks: fetch is mocked and only records the request body.
describe('Gemini prompt content (no network)', () => {
  async function capturePrompt(run: () => Promise<unknown>, modelText: string): Promise<string> {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ candidates: [{ content: { parts: [{ text: modelText }] } }] }),
    });
    global.fetch = fetchSpy;
    await run();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    return JSON.parse(fetchSpy.mock.calls[0][1].body).contents[0].parts[0].text as string;
  }
  const env = () => createMockEnv({ GEMINI_API_KEY: 'test-key' });

  it('claim comparison shows each article\'s real source_id, distinct from its article id, and requires copying it', async () => {
    const { event, articles } = claimComparison04;
    const prompt = await capturePrompt(() => generateClaimComparisonsFromGemini(env(), event, articles, 'gemini-3.5-flash-lite'), '[]');

    expect(prompt).toContain('<article_context id="111">\n  <source_id>111</source_id>');
    expect(prompt).toContain('<article_context id="112">\n  <source_id>111</source_id>');
    expect(prompt).toContain('<article_context id="113">\n  <source_id>112</source_id>');
    expect(prompt).toContain('SOURCE IDS ARE NOT ARTICLE IDS');
    expect(prompt).toContain('Copy each source entry\'s "source_id" exactly from the <source_id> element');
    expect(prompt).toContain('Never use an article ID, a position or count, or a guess as a source_id.');
    expect(prompt).toContain('Every article ID listed in a source entry\'s "article_ids" must have that same <source_id>.');
  });

  it('narrative delta defines all five change types and forbids synonyms such as "corrected"', async () => {
    const { event, articles, narrative_delta_context: ctx } = narrativeDelta02;
    const prompt = await capturePrompt(
      () => generateNarrativeDeltaFromGemini(env(), event, ctx.previous_brief, ctx.previous_version, ctx.current_version, articles, 'gemini-3.5-flash-lite'),
      '{}'
    );

    expect(prompt).toContain('MUST be exactly one of these five values');
    expect(prompt).toContain('"corrected", "updated" or "revised" are NOT allowed');
    for (const definition of [
      '"refined": the earlier claim is made more precise.',
      '"expanded": additional detail or scope is added without contradicting the earlier claim.',
      '"contradicted": current evidence conflicts with the earlier statement without an explicit retraction.',
      '"retracted": the earlier claim was explicitly withdrawn or corrected.',
      '"uncertain": available evidence does not establish the claim\'s status.',
    ]) {
      expect(prompt).toContain(definition);
    }
    expect(prompt).toContain('When an official correction withdraws an earlier figure, use "retracted" for that earlier figure');
    expect(prompt).toContain('"change_type": "refined|expanded|contradicted|retracted|uncertain"');
    // Source IDs are only exposed where the task asks for them.
    expect(prompt).not.toContain('<source_id>');
  });

  it('event brief evidence is unchanged (no source_id element)', async () => {
    const { event, articles } = claimComparison04;
    const prompt = await capturePrompt(() => generateEventBriefFromGemini(env(), event, articles, 'gemini-3.5-flash-lite'), '{}');
    expect(prompt).toContain('<article_context id="113">\n  <source>Regional Emergency Alerts</source>');
    expect(prompt).not.toContain('<source_id>');
  });
});
