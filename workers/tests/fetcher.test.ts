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

import { parseRss } from '../src/tasks/fetcher';

describe('parseRss', () => {
  it('parses RSS 2.0 with missing description and malformed date', () => {
    const xml = `
      <rss><channel>
        <item>
          <title>RSS Title</title>
          <link>http://rss.com/1</link>
          <pubDate>Invalid Date String</pubDate>
          <guid>guid1</guid>
        </item>
      </channel></rss>
    `;
    const res = parseRss(xml);
    expect(res).toHaveLength(1);
    expect(res[0].external_id).toBe('guid1');
    expect(res[0].title).toBe('RSS Title');
    expect(res[0].url).toBe('http://rss.com/1');
    expect(res[0].summary).toBeNull();
    expect(res[0].published_at).toBeNull();
  });

  it('parses Atom feed with href links', () => {
    const xml = `
      <feed>
        <entry>
          <title>Atom Title</title>
          <link href="http://atom.com/1" rel="alternate"/>
          <summary>Atom Summary</summary>
          <updated>2024-01-01T00:00:00Z</updated>
          <id>atom-id-1</id>
        </entry>
      </feed>
    `;
    const res = parseRss(xml);
    expect(res).toHaveLength(1);
    expect(res[0].external_id).toBe('atom-id-1');
    expect(res[0].title).toBe('Atom Title');
    expect(res[0].url).toBe('http://atom.com/1');
    expect(res[0].summary).toBe('Atom Summary');
    expect(res[0].published_at).toBe(1704067200);
  });

  it('deduplicates duplicate IDs in the same feed payload', () => {
    const xml = `
      <feed>
        <entry>
          <title>Title 1</title>
          <link href="http://dup.com/1"/>
          <id>duplicate-id</id>
        </entry>
        <entry>
          <title>Title 2</title>
          <link href="http://dup.com/2"/>
          <id>duplicate-id</id>
        </entry>
      </feed>
    `;
    const res = parseRss(xml);
    expect(res).toHaveLength(1);
    expect(res[0].title).toBe('Title 1');
  });
});
