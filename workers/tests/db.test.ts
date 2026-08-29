import { describe, it, expect } from 'vitest';
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
});
