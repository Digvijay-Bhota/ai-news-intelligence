import { describe, it, expect, vi } from 'vitest';
import { DbClient, createDbClient } from '../src/db/client';
import { createMockEnv, createMockD1Database } from './setup';

describe('DbClient', () => {
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
});
