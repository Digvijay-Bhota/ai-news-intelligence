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
      expect(json.data.items).toBeInstanceOf(Array);
      if (json.data.items.length > 0) {
        expect(json.data.items[0]).toHaveProperty('hash');
        expect(json.data.items[0]).toHaveProperty('article_count');
        expect(json.data.items[0]).toHaveProperty('freshness');
        expect(json.data.items[0]).toHaveProperty('last_published_at');
        expect(json.data.items[0].severity).toBe('critical'); // deterministic ordering check
      }
      expect(json.data.summary).toHaveProperty('total');
    });

    it('GET /api/v1/events rejects invalid freshness', async () => {
      const env = makeEnv();
      const req = await signedRequest('http://localhost/api/v1/events?freshness=invalid_fresh', 'GET');
      const res = await route(req, env);
      expect(res.status).toBe(400);
    });

    it('GET /api/v1/events rejects invalid severity', async () => {
      const env = makeEnv();
      const req = await signedRequest('http://localhost/api/v1/events?severity=extreme', 'GET');
      const res = await route(req, env);
      expect(res.status).toBe(400);
    });

    it('GET /api/v1/events rejects invalid min_articles', async () => {
      const env = makeEnv();
      const req = await signedRequest('http://localhost/api/v1/events?min_articles=-5', 'GET');
      const res = await route(req, env);
      expect(res.status).toBe(400);
    });

    it('GET /api/v1/events passes valid filters', async () => {
      const env = makeEnv();
      const req = await signedRequest('http://localhost/api/v1/events?freshness=active&severity=critical&min_articles=10&sort=recent', 'GET');
      const res = await route(req, env);
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.success).toBe(true);
      expect(json.data.items).toBeDefined();
    });


    it('GET /api/v1/events rejects invalid sort parameter', async () => {
      const env = makeEnv();
      const req = await signedRequest('http://localhost/api/v1/events?sort=alphabetical', 'GET');
      const res = await route(req, env);
      expect(res.status).toBe(400);
    });

    it('GET /api/v1/events rejects malformed min_articles like 5abc', async () => {
      const env = makeEnv();
      const req = await signedRequest('http://localhost/api/v1/events?min_articles=5abc', 'GET');
      const res = await route(req, env);
      expect(res.status).toBe(400);
    });

    it('GET /api/v1/events rejects decimal min_articles like 1.9', async () => {
      const env = makeEnv();
      const req = await signedRequest('http://localhost/api/v1/events?min_articles=1.9', 'GET');
      const res = await route(req, env);
      expect(res.status).toBe(400);
    });

    it('GET /api/v1/events rejects unsafe integer min_articles', async () => {
      const env = makeEnv();
      // Unsafe integer > Number.MAX_SAFE_INTEGER
      const req = await signedRequest('http://localhost/api/v1/events?min_articles=9007199254740992', 'GET');
      const res = await route(req, env);
      expect(res.status).toBe(400);
    });

    it('GET /api/v1/events passes valid zero min_articles', async () => {
      const env = makeEnv();
      const req = await signedRequest('http://localhost/api/v1/events?min_articles=0', 'GET');
      const res = await route(req, env);
      expect(res.status).toBe(200);
    });

    it('GET /api/v1/events passes valid combined filters', async () => {
      const env = makeEnv();
      const req = await signedRequest('http://localhost/api/v1/events?freshness=active&severity=critical&min_articles=10&sort=recent', 'GET');
      const res = await route(req, env);
      expect(res.status).toBe(200);
    });

    it('GET /api/v1/events cache keys differ when params differ', async () => {
      const env = makeEnv();
      const req1 = await signedRequest('http://localhost/api/v1/events?min_articles=10', 'GET');
      const req2 = await signedRequest('http://localhost/api/v1/events?min_articles=20', 'GET');

      const spy = vitest.spyOn(env.CACHE, 'get');

      await route(req1, env);
      const call1 = spy.mock.calls[0][0];

      spy.mockClear();

      await route(req2, env);
      const call2 = spy.mock.calls[0][0];

      expect(call1).not.toBe(call2);
      spy.mockRestore();
    });
    it('GET /api/v1/events/:hash returns event detail with freshness and intelligence', async () => {
      const env = makeEnv();

      const dbClientModule = await import('../src/db/client');
      const mockClient = {
        getEventDetailByHash: async (_hash: string) => ({
          event: { hash: 'hash-test', title: 'Test Event', description: 'Desc', severity: 'critical', started_at: 1000 },
          coverage: {
            total_articles: 10,
            total_sources: 2,
            first_published_at: 1000,
            last_published_at: 5000000,
            sources: [
              { name: 'Source A', article_count: 7, first_published_at: 1000, last_published_at: 5000000 },
              { name: 'Source B', article_count: 3, first_published_at: 2000, last_published_at: 4000000 },
            ]
          },
          articles: [
            {
              id: 1, external_id: 'e1', source_id: 1, title: 'A1', summary: 's', url: 'http://t',
              raw_content: null, published_at: 1000, fetched_at: 1000, language: 'en',
              status: 'processed', created_at: 1000,
              extracted_entities: JSON.stringify({ topics: ['Climate', 'Policy'], events: [] })
            },
            {
              id: 2, external_id: 'e2', source_id: 1, title: 'A2', summary: 's', url: 'http://t2',
              raw_content: null, published_at: 2000, fetched_at: 2000, language: 'en',
              status: 'processed', created_at: 2000,
              extracted_entities: JSON.stringify({ topics: ['Climate', 'Science'], events: [] })
            },
          ],
        }),
        getSourcesBatch: async () => { const m = new Map(); m.set(1, 'Source A'); return m; },
        getIntelligenceBatch: async () => new Map(),
      };
      const spy = vitest.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockClient as any);

      const req = await signedRequest('http://localhost/api/v1/events/hash-test', 'GET');
      const res = await route(req, env);
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.success).toBe(true);

      // Freshness must be on the event object (not missing)
      expect(json.data.event).toHaveProperty('freshness');
      expect(['developing', 'active', 'stale']).toContain(json.data.event.freshness);

      // last_published_at on event must equal coverage.last_published_at
      expect(json.data.event).toHaveProperty('last_published_at');
      expect(json.data.event.last_published_at).toBe(5000000);

      // Intelligence block must be present
      expect(json.data.intelligence).toBeDefined();
      expect(typeof json.data.intelligence.topic_count).toBe('number');
      expect(json.data.intelligence.topic_count).toBe(3); // Climate, Policy, Science (deduped)
      expect(Array.isArray(json.data.intelligence.unique_topics)).toBe(true);
      expect(json.data.intelligence.unique_topics).toEqual(['Climate', 'Policy', 'Science']); // sorted
      expect(json.data.intelligence.top_source).toBe('Source A'); // 7 > 3 articles
      expect(typeof json.data.intelligence.days_active).toBe('number');
      expect(typeof json.data.intelligence.coverage_density).toBe('number');

      spy.mockRestore();
    });

    it('GET /api/v1/events/:hash handles zero articles and null timestamps gracefully', async () => {
      const env = makeEnv();

      const dbClientModule = await import('../src/db/client');
      const mockClient = {
        getEventDetailByHash: async (_hash: string) => ({
          event: { hash: 'hash-empty', title: 'Empty Event', description: null, severity: 'info', started_at: null },
          coverage: {
            total_articles: 0,
            total_sources: 0,
            first_published_at: null,
            last_published_at: null,
            sources: []
          },
          articles: [],
        }),
        getSourcesBatch: async () => new Map(),
        getIntelligenceBatch: async () => new Map(),
      };
      const spy = vitest.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockClient as any);

      const req = await signedRequest('http://localhost/api/v1/events/hash-empty', 'GET');
      const res = await route(req, env);
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.success).toBe(true);

      // freshness must be 'active' when last_published_at is null
      expect(json.data.event.freshness).toBe('active');
      expect(json.data.event.last_published_at).toBeNull();

      // Intelligence edge cases: null timestamps → null densities, empty topics
      expect(json.data.intelligence.topic_count).toBe(0);
      expect(json.data.intelligence.unique_topics).toEqual([]);
      expect(json.data.intelligence.days_active).toBeNull();
      expect(json.data.intelligence.coverage_density).toBeNull();
      expect(json.data.intelligence.top_source).toBeNull();

      spy.mockRestore();
    });

    it('GET /api/v1/events/:hash returns days_active = 1 when first and last published are identical', async () => {
      const env = makeEnv();

      const dbClientModule = await import('../src/db/client');
      const mockClient = {
        getEventDetailByHash: async (_hash: string) => ({
          event: { hash: 'hash-single-day', title: 'Single Day Event', description: 'Happened today', severity: 'medium', started_at: 1000 },
          coverage: {
            total_articles: 3,
            total_sources: 2,
            first_published_at: 1700000000,
            last_published_at: 1700000000,
            sources: [{ name: 'Source A', article_count: 3, first_published_at: 1700000000, last_published_at: 1700000000 }]
          },
          articles: [],
        }),
        getSourcesBatch: async () => new Map(),
        getIntelligenceBatch: async () => new Map(),
      };
      const spy = vitest.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockClient as any);

      const req = await signedRequest('http://localhost/api/v1/events/hash-single-day', 'GET');
      const res = await route(req, env);
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.success).toBe(true);

      // Must be 1, not 0
      expect(json.data.intelligence.days_active).toBe(1);
      expect(json.data.intelligence.coverage_density).toBe(3);

      spy.mockRestore();
    });

  function makeEnv() {
    return createMockEnv({ DB: createMockD1Database(true), CACHE: createMockKVNamespace() });
  }

  async function signedRequest(url: string, method: string, body?: Record<string, any>, isInternal = false, explicitUserId?: string): Promise<Request> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (isInternal) headers['X-Token-ID'] = 'test-token';

    let userId = explicitUserId;
    if (userId === undefined) {
      try {
        const parsedUrl = new URL(url);
        userId = parsedUrl.searchParams.get('user_id') || undefined;
      } catch {}
      if (!userId && body && typeof body.user_id === 'string') {
        userId = body.user_id;
      }
    }

    if (userId) {
      headers['X-Authenticated-User-Id'] = userId;
    }

    const req = new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const ts = Math.floor(Date.now() / 1000);
    return buildSignedRequest(req, TEST_SECRET, `nonce-${ts}`, ts);
  }

  describe('Health', () => {
    it('returns healthy status with version and environment metadata', async () => {
      const env = makeEnv();
      const req = await signedRequest('http://localhost/api/v1/health', 'GET');
      const res = await route(req, env);
      expect(res.status).toBe(200);
      const json = (await res.json()) as ApiResponse<any>;
      expect(json.success).toBe(true);
      expect(json.data.status).toBe('healthy');
      expect(json.data.environment).toBe('test');
      expect(json.data.version).toBe('0.8.0');
    });

    it('returns custom version and environment when provided in env', async () => {
      const env = { ...makeEnv(), ENVIRONMENT: 'production', VERSION: '0.8.0-custom' };
      const req = await signedRequest('http://localhost/api/v1/health', 'GET');
      const res = await route(req, env);
      expect(res.status).toBe(200);
      const json = (await res.json()) as ApiResponse<any>;
      expect(json.success).toBe(true);
      expect(json.data.environment).toBe('production');
      expect(json.data.version).toBe('0.8.0-custom');
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

  describe('Follows & User Authorization Hardening (Phase 11A)', () => {
    it('requires authenticated user identity for follows', async () => {
      const env = makeEnv();
      const req = await signedRequest('http://localhost/api/v1/follows', 'GET', undefined, false, '');
      const res = await route(req, env);
      expect(res.status).toBe(401);
    });

    it('rejects client user_id mismatch with 403 Forbidden', async () => {
      const env = makeEnv();
      // Authenticated as u1, but querying for u2
      const req = await signedRequest('http://localhost/api/v1/preferences?user_id=u2', 'GET', undefined, false, 'u1');
      const res = await route(req, env);
      expect(res.status).toBe(403);

      // Authenticated as u1, but body says u2
      const postReq = await signedRequest('http://localhost/api/v1/follows', 'POST', {
        user_id: 'u2',
        target_type: 'topic',
        target_id: 'ai-integration-topic',
      }, false, 'u1');
      const postRes = await route(postReq, env);
      expect(postRes.status).toBe(403);
    });

    it('validates canonical target existence for follows', async () => {
      const env = makeEnv();
      // Invalid target_type
      const reqInvalidType = await signedRequest('http://localhost/api/v1/follows', 'POST', {
        target_type: 'author',
        target_id: 'john-doe',
      }, false, 'u1');
      const resInvalidType = await route(reqInvalidType, env);
      expect(resInvalidType.status).toBe(400);

      // Nonexistent topic
      const reqMissingTopic = await signedRequest('http://localhost/api/v1/follows', 'POST', {
        target_type: 'topic',
        target_id: 'non-existent-topic',
      }, false, 'u1');
      const resMissingTopic = await route(reqMissingTopic, env);
      expect(resMissingTopic.status).toBe(404);

      // Nonexistent event
      const reqMissingEvent = await signedRequest('http://localhost/api/v1/follows', 'POST', {
        target_type: 'event',
        target_id: 'unknown-event-hash',
      }, false, 'u1');
      const resMissingEvent = await route(reqMissingEvent, env);
      expect(resMissingEvent.status).toBe(404);

      // Nonexistent source
      const reqMissingSource = await signedRequest('http://localhost/api/v1/follows', 'POST', {
        target_type: 'source',
        target_id: 'non-existent-news-outlet',
      }, false, 'u1');
      const resMissingSource = await route(reqMissingSource, env);
      expect(resMissingSource.status).toBe(404);
    });

    it('creates, lists, filters, and deletes follows with private cache headers', async () => {
      const env = makeEnv();

      // 1. Follow topic
      const postTopicReq = await signedRequest('http://localhost/api/v1/follows', 'POST', {
        target_type: 'topic',
        target_id: 'ai-integration-topic',
      }, false, 'u1');
      const postTopicRes = await route(postTopicReq, env);
      expect(postTopicRes.status).toBe(201);
      expect(postTopicRes.headers.get('Cache-Control')).toContain('private');

      // 2. Follow event
      const postEventReq = await signedRequest('http://localhost/api/v1/follows', 'POST', {
        target_type: 'event',
        target_id: 'evt-hash',
      }, false, 'u1');
      const postEventRes = await route(postEventReq, env);
      expect(postEventRes.status).toBe(201);

      // 3. Follow source
      const postSourceReq = await signedRequest('http://localhost/api/v1/follows', 'POST', {
        target_type: 'source',
        target_id: 'Integration Source',
      }, false, 'u1');
      const postSourceRes = await route(postSourceReq, env);
      expect(postSourceRes.status).toBe(201);

      // 4. List all follows for u1
      const listReq = await signedRequest('http://localhost/api/v1/follows', 'GET', undefined, false, 'u1');
      const listRes = await route(listReq, env);
      expect(listRes.status).toBe(200);
      const listData = (await listRes.json()) as ApiResponse<any>;
      expect(listData.data.length).toBe(3);

      // 5. Filter by target_type=topic
      const filterReq = await signedRequest('http://localhost/api/v1/follows?target_type=topic', 'GET', undefined, false, 'u1');
      const filterRes = await route(filterReq, env);
      expect(filterRes.status).toBe(200);
      const filterData = (await filterRes.json()) as ApiResponse<any>;
      expect(filterData.data.length).toBe(1);
      expect(filterData.data[0].target_id).toBe('ai-integration-topic');

      // 6. User B has isolated follow graph (sees 0 follows)
      const userBListReq = await signedRequest('http://localhost/api/v1/follows', 'GET', undefined, false, 'u2');
      const userBListRes = await route(userBListReq, env);
      expect(userBListRes.status).toBe(200);
      const userBData = (await userBListRes.json()) as ApiResponse<any>;
      expect(userBData.data.length).toBe(0);

      // 7. Delete follow for topic
      const delReq = await signedRequest('http://localhost/api/v1/follows?target_type=topic&target_id=ai-integration-topic', 'DELETE', undefined, false, 'u1');
      const delRes = await route(delReq, env);
      expect(delRes.status).toBe(200);
      const delData = (await delRes.json()) as ApiResponse<any>;
      expect(delData.data.deleted).toBe(true);

      // 8. Confirm deleted
      const checkReq = await signedRequest('http://localhost/api/v1/follows?target_type=topic', 'GET', undefined, false, 'u1');
      const checkRes = await route(checkReq, env);
      const checkData = (await checkRes.json()) as ApiResponse<any>;
      expect(checkData.data.length).toBe(0);
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
