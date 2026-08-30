import { describe, it, expect, vi } from 'vitest';
import { generateArticleHash } from '../src/tasks/normalization';
import { fetchAndIngest } from '../src/tasks/fetcher';
import { createMockEnv } from './setup';
import * as dbClientModule from '../src/db/client';
import type { Source } from '../src/types';

describe('Normalization and Deduplication', () => {
  describe('generateArticleHash', () => {
    it('generates deterministic hashes', async () => {
      const h1 = await generateArticleHash('  Test Title  ', 'http://example.com/url');
      const h2 = await generateArticleHash('test title', 'HTTP://EXAMPLE.COM/URL');
      expect(h1).toBe(h2);
    });

    it('generates different hashes for different articles', async () => {
      const h1 = await generateArticleHash('Title 1', 'url1');
      const h2 = await generateArticleHash('Title 2', 'url2');
      expect(h1).not.toBe(h2);
    });
  });

  describe('fetchAndIngest deduplication', () => {
    it('skips duplicate articles', async () => {
      const env = createMockEnv();
      const source: Source = {
        id: 1,
        name: 'Test Source',
        feed_url: 'http://example.com/rss',
        base_url: 'http://example.com',
        source_type: 'rss',
        reliability_score: 1.0,
        fetch_interval_minutes: 60,
        active: 1,
        last_fetched_at: null,
        created_at: 0,
        updated_at: 0,
      };

      const rssXml = `
        <rss version="2.0">
          <channel>
            <item>
              <title>Test Title</title>
              <link>http://example.com/article1</link>
              <description>Test Summary</description>
              <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
            </item>
          </channel>
        </rss>
      `;

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(rssXml),
      });

      // Mock DbClient
      const mockDbClient = {
        getDedupHash: vi.fn().mockResolvedValue({ id: 1 }), // Article already exists
        createArticle: vi.fn(),
        createDedupHash: vi.fn(),
      };
      vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockDbClient as any);

      const ingested = await fetchAndIngest(env, source);
      expect(ingested).toBe(0);
      expect(mockDbClient.createArticle).not.toHaveBeenCalled();
    });
  });
});
