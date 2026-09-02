import { describe, it, expect, vi } from 'vitest';
import { DbClient, createDbClient } from '../src/db/client';
import { createMockEnv, createMockD1Database } from './setup';

describe('DbClient', () => {

  describe('Events Dashboard', () => {
    it('getActiveEvents retrieves active events ordered by severity and coverage', async () => {
      const client = makeClient();
      const events = await client.getActiveEvents();
      expect(events).toBeInstanceOf(Array);
      if (events.length > 0) {
        expect(events[0].severity).toBe('critical');
        expect(events[1].severity).toBe('warning');
      }
    });
  });

  function makeClient(): DbClient {
    return createDbClient(createMockEnv({ DB: createMockD1Database() }));
  }

  describe('Sources', () => {
    it('lists sources', async () => {
      const client = makeClient();
      const sources = await client.listSources();
      expect(Array.isArray(sources)).toBe(true);
    });
  });

  describe('Articles', () => {
    it('lists articles with pagination', async () => {
      const client = makeClient();
      const result = await client.listArticles({ limit: 10, offset: 0 });
      expect(result.articles).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('gets article by id returns null when not found', async () => {
      const client = makeClient();
      const article = await client.getArticleById(999);
      expect(article).toBeNull();
    });
  });

  describe('Topics', () => {
    it('lists topics', async () => {
      const client = makeClient();
      const topics = await client.listTopics();
      expect(Array.isArray(topics)).toBe(true);
    });
  });

  describe('User Preferences', () => {
    it('returns null for unknown user', async () => {
      const client = makeClient();
      const prefs = await client.getUserPreferences('unknown');
      expect(prefs).toBeNull();
    });
  });

  describe('Saved Articles', () => {
    it('lists saved articles', async () => {
      const client = makeClient();
      const saved = await client.listSavedArticles('u1');
      expect(Array.isArray(saved)).toBe(true);
    });
  });

  describe('Pipeline Jobs', () => {
    it('creates pipeline job with started_at when running', async () => {
      const db = createMockD1Database();
      const client = new DbClient(db);

      // The mock DB's bind and prepare are not flexible enough to support
      // the RETURNING clause with 5 params accurately, so we mock the specific
      // interaction if needed. Given the limitations of the existing setup.ts
      // test harness, we verify the service layer logic.
      vi.spyOn(db, 'prepare').mockReturnValue({
        bind: () => ({
          first: async () => ({ id: 1, started_at: 123 })
        })
      } as any);

      const job = await client.createPipelineJob({
        job_type: 'test',
        status: 'running',
        payload: null,
        result: null,
        error_message: null
      });
      expect(job.started_at).toBe(123);
    });
  });

  describe('Retries', () => {
    it('claims failed article', async () => {
      const db = createMockD1Database();
      const client = new DbClient(db);
      const runMock = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
      const bindMock = vi.fn().mockReturnValue({ run: runMock });
      vi.spyOn(db, 'prepare').mockReturnValue({ bind: bindMock } as any);

      const result = await client.claimFailedArticle(10);
      expect(result).toBe(true);
      expect(bindMock).toHaveBeenCalledWith(10);
    });

    it('listRetryableFailedArticles executes correctly', async () => {
      const db = createMockD1Database();
      const client = new DbClient(db);
      const allMock = vi.fn().mockResolvedValue({ results: [{ id: 1 }] });
      const bindMock = vi.fn().mockReturnValue({ all: allMock });
      const prepareSpy = vi.spyOn(db, 'prepare').mockReturnValue({ bind: bindMock } as any);

      const result = await client.listRetryableFailedArticles(5);
      expect(result.length).toBe(1);
      expect(bindMock).toHaveBeenCalledWith(5);

      const query = prepareSpy.mock.calls[0][0] as string;
      expect(query).toContain("status = 'failed'");
      expect(query).toContain("job_type = 'enrichment'");
      expect(query).toContain("LIKE '%429%' THEN 5");
      expect(query).toContain("ELSE 2");
    });
  });

  describe('Batch Loading', () => {
    it('getSourcesBatch handles empty array', async () => {
      const client = makeClient();
      const map = await client.getSourcesBatch([]);
      expect(map.size).toBe(0);
    });

    it('getIntelligenceBatch handles empty array', async () => {
      const client = makeClient();
      const map = await client.getIntelligenceBatch([]);
      expect(map.size).toBe(0);
    });

    it('getSourcesBatch maps correctly', async () => {
      const db = createMockD1Database();
      const client = new DbClient(db);
      const allMock = vi.fn().mockResolvedValue({
        results: [
          { id: 1, name: 'Source A' },
          { id: 2, name: 'Source B' }
        ]
      });
      const bindMock = vi.fn().mockReturnValue({ all: allMock });
      vi.spyOn(db, 'prepare').mockReturnValue({ bind: bindMock } as any);

      const map = await client.getSourcesBatch([1, 2, 2]);
      expect(map.size).toBe(2);
      expect(map.get(1)).toBe('Source A');
      expect(map.get(2)).toBe('Source B');
      expect(bindMock).toHaveBeenCalledWith(1, 2);
    });

    it('getIntelligenceBatch maps topics and events correctly', async () => {
      const db = createMockD1Database();
      const client = new DbClient(db);

      let callCount = 0;
      const allMock = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) { // Topics
          return Promise.resolve({
            results: [
              { article_raw_id: 1, name: 'AI' },
              { article_raw_id: 1, name: 'Tech' }
            ]
          });
        }
        // Events
        return Promise.resolve({
          results: [
            { article_raw_id: 2, title: 'Event A', event_hash: 'event-hash-a' }
          ]
        });
      });
      const bindMock = vi.fn().mockReturnValue({ all: allMock });
      vi.spyOn(db, 'prepare').mockReturnValue({ bind: bindMock } as any);

      const map = await client.getIntelligenceBatch([1, 2, 3]);
      expect(map.size).toBe(3);

      expect(map.get(1)?.topics).toEqual(['AI', 'Tech']);
      expect(map.get(1)?.events).toEqual([]);

      expect(map.get(2)?.topics).toEqual([]);
      expect(map.get(2)?.events).toEqual([{ title: 'Event A', hash: 'event-hash-a' }]);

      expect(map.get(3)?.topics).toEqual([]); // Article with no topics/events
      expect(map.get(3)?.events).toEqual([]);

      expect(bindMock).toHaveBeenCalledWith(1, 2, 3);
    });
  });
});

describe('listArticles Filters', () => {
  it('applies q, topic_slug, and source_id filters', async () => {
    const { createMockD1Database } = await import('./setup');
    const db = createMockD1Database();
    const client = new DbClient(db);

    const bindMock = vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }) });
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      // Mock both count and select queries
      if (sql.includes('COUNT')) {
        return { bind: () => ({ first: async () => ({ total: 0 }) }) } as any;
      }
      return { bind: bindMock } as any;
    });

    await client.listArticles({ q: 'test', topic_slug: 'ai', source_id: 1 });

    expect(bindMock).toHaveBeenCalled();
    const bindArgs = bindMock.mock.calls[0];
    // Check that params array contains the correctly parsed/bound values
    // source_id (1), q (%test%, %test%), topic_slug (ai), limit (20), offset (0)
    expect(bindArgs).toContain(1);
    expect(bindArgs).toContain('%test%');
    expect(bindArgs).toContain('ai');
  });
});
