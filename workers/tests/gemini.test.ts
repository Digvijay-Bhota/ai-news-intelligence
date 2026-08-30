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
});
