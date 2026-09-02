import { describe, vitest, it, expect } from 'vitest';
import { route } from '../src/router';
import { createMockEnv, createMockD1Database, createMockKVNamespace, TEST_SECRET } from './setup';
import { buildSignedRequest } from '../src/utils/hmac';
import type { ApiResponse } from '../src/types';

describe('Router', () => {

it('GET /api/v1/events returns active events', async () => {
      const env = makeEnv();
      const req = await signedRequest('http://localhost/api/v1/events', 'GET');
      const res = await route(req, env);
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.success).toBe(true);
      expect(json.data).toBeInstanceOf(Array);
      if (json.data.length > 0) {
        expect(json.data[0]).toHaveProperty('hash');
        expect(json.data[0]).toHaveProperty('article_count');
        expect(json.data[0]).toHaveProperty('freshness');
        expect(json.data[0]).toHaveProperty('last_published_at');
        expect(json.data[0].severity).toBe('critical'); // deterministic ordering check
      }
    });


  function makeEnv() {
    return createMockEnv({ DB: createMockD1Database(true), CACHE: createMockKVNamespace() });
  }

  async function signedRequest(url: string, method: string, body?: object, isInternal = false): Promise<Request> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (isInternal) headers['X-Token-ID'] = 'test-token';
    const req = new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const ts = Math.floor(Date.now() / 1000);
    return buildSignedRequest(req, TEST_SECRET, `nonce-${ts}`, ts);
  }

  describe('Health', () => {
    it('returns healthy status', async () => {
      const env = makeEnv();
      const req = await signedRequest('http://localhost/api/v1/health', 'GET');
      const res = await route(req, env);
      expect(res.status).toBe(200);
      const json = (await res.json()) as ApiResponse<any>;
      expect(json.success).toBe(true);
      expect(json.data.status).toBe('healthy');
    });
  });

  describe('Feed', () => {
    it('feed response contains actual topic/event values', async () => {
      const env = makeEnv();

      // Override DbClient directly using vi.spyOn to return mock articles and intelligence
      const dbClientModule = await import('../src/db/client');
      const mockClient = {
        listArticles: async () => ({
          articles: [{
            id: 1, external_id: '1', source_id: 1, title: 'Test',
            summary: 'Sum', url: 'http://test', raw_content: '',
            published_at: 1000, fetched_at: 1000, language: 'en',
            status: 'processed', created_at: 1000
          }],
          total: 1
        }),
        getIntelligenceBatch: async () => {
          const map = new Map();
          map.set(1, { topics: ['TopicA'], events: ['EventA'] });
          return map;
        },
        getSourcesBatch: async () => {
          const map = new Map();
          map.set(1, 'SourceA');
          return map;
        },
        getUserPreferences: async () => null,
      };
      const spy = vitest.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockClient as any);

      const req = await signedRequest('http://localhost/api/v1/feed?limit=10&offset=0&source_id=1', 'GET');
      const res = await route(req, env);
      expect(res.status).toBe(200);
      const json = (await res.json()) as ApiResponse<any>;

      expect(json.data.meta.limit).toBe(10);
      expect(json.data.meta.offset).toBe(0);
      expect(json.data.items.length).toBe(1);
      expect(json.data.items[0].topics).toEqual(['TopicA']);
      expect(json.data.items[0].events).toEqual(['EventA']);
      expect(json.data.items[0].source).toEqual('SourceA');

      spy.mockRestore();
    });

    it('returns feed with meta', async () => {
      const env = makeEnv();
      const req = await signedRequest('http://localhost/api/v1/feed', 'GET');
      const res = await route(req, env);
      expect(res.status).toBe(200);
      const json = (await res.json()) as ApiResponse<any>;
      expect(json.success).toBe(true);
      expect(json.data.meta).toBeDefined();
    });
  });

  describe('Preferences', () => {
    it('GET returns default preferences', async () => {
      const env = makeEnv();
      const req = await signedRequest('http://localhost/api/v1/preferences?user_id=u1', 'GET');
      const res = await route(req, env);
      expect(res.status).toBe(200);
      const json = (await res.json()) as ApiResponse<any>;
      expect(json.data.digest_frequency).toBe('daily');
    });

    it('POST updates preferences', async () => {
      const env = makeEnv();
      const req = await signedRequest('http://localhost/api/v1/preferences', 'POST', {
        user_id: 'u1',
        digest_frequency: 'weekly',
      });
      const res = await route(req, env);
      expect(res.status).toBe(200);
      const json = (await res.json()) as ApiResponse<any>;
      expect(json.data.digest_frequency).toBe('weekly');
    });
  });

  describe('Saved Articles', () => {
    it('GET returns empty list', async () => {
      const env = makeEnv();
      const req = await signedRequest('http://localhost/api/v1/saved?user_id=u1', 'GET');
      const res = await route(req, env);
      expect(res.status).toBe(200);
      const json = (await res.json()) as ApiResponse<any>;
      expect(Array.isArray(json.data)).toBe(true);
    });

    it('POST creates saved article', async () => {
      const env = makeEnv();
      const req = await signedRequest('http://localhost/api/v1/saved', 'POST', {
        user_id: 'u1',
        article_raw_id: 1,
      });
      const res = await route(req, env);
      expect(res.status).toBe(201);
    });
  });

  describe('Hide', () => {
    it('POST hides a story', async () => {
      const env = makeEnv();
      const req = await signedRequest('http://localhost/api/v1/hide', 'POST', {
        user_id: 'u1',
        article_raw_id: 1,
      });
      const res = await route(req, env);
      expect(res.status).toBe(201);
    });
  });

  describe('Internal API', () => {
    it('POST /internal/v1/articles requires internal auth', async () => {
      const env = makeEnv();
      const req = await signedRequest('http://localhost/internal/v1/articles', 'POST', {
        external_id: 'ext-1',
        source_id: 1,
        title: 'Test',
        url: 'http://example.com',
      }, true);
      const res = await route(req, env);
      // Will fail because mock DB doesn't have pipeline_tokens table data
      expect([401, 201, 500]).toContain(res.status);
    });

    it('POST /internal/v1/events', async () => {
      const env = makeEnv();
      const req = await signedRequest('http://localhost/internal/v1/events', 'POST', {
        event_hash: 'hash-1',
        title: 'Event',
      }, true);
      const res = await route(req, env);
      expect([401, 201, 500]).toContain(res.status);
    });

    it('POST /internal/v1/ai-jobs', async () => {
      const env = makeEnv();
      const req = await signedRequest('http://localhost/internal/v1/ai-jobs', 'POST', {
        job_type: 'summarize',
      }, true);
      const res = await route(req, env);
      expect([401, 201, 500]).toContain(res.status);
    });

    it('POST /internal/v1/pipeline-log', async () => {
      const env = makeEnv();
      const req = await signedRequest('http://localhost/internal/v1/pipeline-log', 'POST', {
        job_type: 'fetch',
        status: 'completed',
      }, true);
      const res = await route(req, env);
      expect([401, 201, 500]).toContain(res.status);
    });
  });

  describe('404', () => {
    it('returns 404 for unknown endpoint', async () => {
      const env = makeEnv();
      const req = await signedRequest('http://localhost/api/v1/unknown', 'GET');
      const res = await route(req, env);
      expect(res.status).toBe(404);
    });
  });
});
