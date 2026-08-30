import { describe, it, expect, vi } from 'vitest';
import { generateEnrichment } from '../src/tasks/gemini';
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
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

    await expect(generateEnrichment(env, 'prompt')).rejects.toThrow();
  });
});
