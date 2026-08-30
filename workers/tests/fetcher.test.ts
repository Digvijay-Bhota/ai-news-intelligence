import { describe, it, expect, vi } from 'vitest';
import { fetchAndIngest } from '../src/tasks/fetcher';
import { createMockEnv } from './setup';
import * as dbClientModule from '../src/db/client';
import type { Source } from '../src/types';

describe('fetchAndIngest', () => {
  it('fetches and persists RSS articles', async () => {
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

    // Mock global fetch
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(rssXml),
    });

    // Mock DbClient
    const mockDbClient = {
      getArticleByExternalId: vi.fn().mockResolvedValue(null),
      createArticle: vi.fn().mockResolvedValue({ id: 1 }),
      getDedupHash: vi.fn().mockResolvedValue(null),
      createDedupHash: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockDbClient as any);

    const ingested = await fetchAndIngest(env, source);
    expect(ingested).toBe(1);
    expect(global.fetch).toHaveBeenCalledWith('http://example.com/rss');
    expect(mockDbClient.createArticle).toHaveBeenCalled();
  });
});
