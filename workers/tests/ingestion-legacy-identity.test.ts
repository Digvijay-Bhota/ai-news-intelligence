/// <reference types="vite/client" />
/**
 * Rows stored by the parser before XML entity decoding and Atom rel filtering
 * keep their encoded external_id, title and URL (and a hash of them). Ingesting
 * the same feeds with the corrected parser must not insert them again. Runs
 * against an isolated local D1 binding (Miniflare); feeds are stubbed.
 *
 * See source-initialization.test.ts for why `cloudflare:test-internal` is used.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error -- untyped pool runtime module (see header comment)
import { env as workerEnv } from 'cloudflare:test-internal';
import schemaSql from '../../d1/schema.sql?raw';
import { fetchAndIngest, parseRss } from '../src/tasks/fetcher';
import { generateArticleHash } from '../src/tasks/normalization';
import { createMockEnv } from './setup';
import type { Source } from '../src/types';

const DB = (workerEnv as unknown as { DB: D1Database }).DB;
const RSS_URL = 'https://feeds.example.test/legacy-rss.xml';
const ATOM_URL = 'https://feeds.example.test/legacy-atom.xml';
const WIRE_URL = 'https://feeds.example.test/legacy-wire.xml';

const RSS_FEED = `<rss version="2.0"><channel>
<item><title>Chips &amp; models</title><link>https://news.example.test/story?id=1&amp;src=rss</link><description>&lt;p&gt;Fish &amp;amp; chips&lt;/p&gt;</description></item>
<item><title>AT&amp;T signs AI deal</title><link>https://news.example.test/att</link><guid isPermaLink="false">tag:news.example.test,2026:att?v=1&amp;r=2</guid></item>
<item><title>OpenAI &amp; Microsoft update</title><link>https://wire.example.test/update</link><guid>syndicated-1</guid></item>
</channel></rss>`;

const ATOM_FEED = `<feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>Atom &lt;b&gt;bold&lt;/b&gt; claim</title><link rel="enclosure" type="image/jpeg" href="https://img.example.test/e.jpg"/><link rel="self" href="https://news.example.test/feed/e"/><link rel="alternate" href="https://news.example.test/e?a=1&amp;b=2"/><id>urn:example:e?x=1&amp;y=2</id><updated>2026-10-01T00:00:00Z</updated></entry>
</feed>`;

/**
 * What the pre-decoding parser (origin/main 283f294) stored for the entries
 * above, as produced by running that parser on these exact feeds. The wire
 * story was stored from another source under its own guid, so only its hash
 * can match the syndicated copy.
 */
const LEGACY_ROWS = [
  { feed: 'rss', external_id: 'https://news.example.test/story?id=1&amp;src=rss', title: 'Chips &amp; models', url: 'https://news.example.test/story?id=1&amp;src=rss' },
  { feed: 'rss', external_id: 'tag:news.example.test,2026:att?v=1&amp;r=2', title: 'AT&amp;T signs AI deal', url: 'https://news.example.test/att' },
  { feed: 'wire', external_id: 'wire-1', title: 'OpenAI &amp; Microsoft update', url: 'https://wire.example.test/update' },
  { feed: 'atom', external_id: 'urn:example:e?x=1&amp;y=2', title: 'Atom &lt;b&gt;bold&lt;/b&gt; claim', url: 'https://img.example.test/e.jpg' },
];

function splitSql(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^PRAGMA\b/i.test(s));
}

async function createSource(name: string, feedUrl: string): Promise<Source> {
  return (await DB.prepare(
    `INSERT INTO sources (name, feed_url, base_url, source_type, active)
     VALUES (?1, ?2, 'https://news.example.test', 'rss', 1)
     ON CONFLICT(name) DO UPDATE SET feed_url = excluded.feed_url
     RETURNING *`
  ).bind(name, feedUrl).first<Source>())!;
}

/** Insert rows exactly as the previous fetchAndIngest stored them. */
async function seedLegacyRows(sources: Record<string, Source>): Promise<void> {
  for (const row of LEGACY_ROWS) {
    const inserted = await DB.prepare(
      `INSERT INTO articles_raw (external_id, source_id, title, url, language, status)
       VALUES (?1, ?2, ?3, ?4, 'en', 'processed') RETURNING id`
    ).bind(row.external_id, sources[row.feed].id, row.title, row.url).first<{ id: number }>();
    await DB.prepare("INSERT INTO dedup_hashes (hash, article_raw_id, hash_type) VALUES (?1, ?2, 'content')")
      .bind(await generateArticleHash(row.title, row.url), inserted!.id).run();
  }
}

function serveFeeds(feeds: Record<string, string>): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url in feeds) return new Response(feeds[url], { status: 200 });
    throw new Error(`Unexpected outbound fetch in test: ${url}`);
  }));
}

const snapshot = async () => ({
  articles: (await DB.prepare('SELECT * FROM articles_raw ORDER BY id').all()).results,
  hashes: (await DB.prepare('SELECT * FROM dedup_hashes ORDER BY id').all()).results,
});

describe('Ingestion of feeds stored by the pre-decoding parser (local D1)', () => {
  let sources: Record<string, Source>;

  beforeEach(async () => {
    for (const stmt of splitSql(schemaSql)) await DB.prepare(stmt).run();
    sources = {
      rss: await createSource('Legacy Entity RSS Feed', RSS_URL),
      atom: await createSource('Legacy Entity Atom Feed', ATOM_URL),
      wire: await createSource('Legacy Entity Wire Feed', WIRE_URL),
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('only legacy identifiers can match the seeded rows', async () => {
    await seedLegacyRows(sources);
    const parsed = [...parseRss(RSS_FEED), ...parseRss(ATOM_FEED)];
    expect(parsed).toHaveLength(LEGACY_ROWS.length);
    for (const article of parsed) {
      // Without the legacy lookup every entry would look new.
      expect(await DB.prepare('SELECT 1 FROM articles_raw WHERE external_id = ?1').bind(article.external_id).first()).toBeNull();
      const hash = await generateArticleHash(article.title, article.url);
      expect(await DB.prepare('SELECT 1 FROM dedup_hashes WHERE hash = ?1').bind(hash).first()).toBeNull();
      expect(article.legacy).toBeDefined();
    }
    expect(parsed.map(a => a.url)).toEqual([
      'https://news.example.test/story?id=1&src=rss',
      'https://news.example.test/att',
      'https://wire.example.test/update',
      'https://news.example.test/e?a=1&b=2',
    ]);
  });

  it('re-ingesting the legacy feeds creates zero duplicate articles and leaves rows untouched', async () => {
    await seedLegacyRows(sources);
    const before = await snapshot();
    const env = createMockEnv({ DB });
    serveFeeds({ [RSS_URL]: RSS_FEED, [ATOM_URL]: ATOM_FEED });

    expect((await fetchAndIngest(env, sources.rss)).inserted).toBe(0);
    expect((await fetchAndIngest(env, sources.atom)).inserted).toBe(0);
    expect((await fetchAndIngest(env, sources.rss)).inserted).toBe(0);

    expect(await snapshot()).toEqual(before);
  });

  it('stores decoded fields for new stories and recognizes them on the next fetch', async () => {
    await seedLegacyRows(sources);
    const newItem = '<item><title>New &amp; noteworthy</title><link>https://news.example.test/new?a=1&amp;b=2</link></item>';
    const env = createMockEnv({ DB });
    serveFeeds({ [RSS_URL]: RSS_FEED.replace('<channel>', `<channel>${newItem}`) });

    expect((await fetchAndIngest(env, sources.rss)).inserted).toBe(1);
    const row = await DB.prepare('SELECT * FROM articles_raw WHERE source_id = ?1 AND title = ?2')
      .bind(sources.rss.id, 'New & noteworthy').first<any>();
    expect(row).toMatchObject({
      external_id: 'https://news.example.test/new?a=1&b=2',
      url: 'https://news.example.test/new?a=1&b=2',
      status: 'pending',
      image_url: null,
      image_credit: null,
    });
    const hash = await generateArticleHash('New & noteworthy', 'https://news.example.test/new?a=1&b=2');
    expect(await DB.prepare('SELECT article_raw_id FROM dedup_hashes WHERE hash = ?1').bind(hash).first()).toEqual({ article_raw_id: row.id });

    const after = await snapshot();
    expect((await fetchAndIngest(env, sources.rss)).inserted).toBe(0);
    expect(await snapshot()).toEqual(after);
    expect(after.articles).toHaveLength(LEGACY_ROWS.length + 1);
  });

  it('ingests corrected feeds once into an empty database', async () => {
    const env = createMockEnv({ DB });
    serveFeeds({ [RSS_URL]: RSS_FEED, [ATOM_URL]: ATOM_FEED });

    expect((await fetchAndIngest(env, sources.rss)).inserted).toBe(3);
    expect((await fetchAndIngest(env, sources.atom)).inserted).toBe(1);
    const first = await snapshot();
    expect((await fetchAndIngest(env, sources.rss)).inserted).toBe(0);
    expect((await fetchAndIngest(env, sources.atom)).inserted).toBe(0);
    expect(await snapshot()).toEqual(first);

    expect(first.articles.map((r: any) => ({ external_id: r.external_id, title: r.title, url: r.url, summary: r.summary }))).toEqual([
      { external_id: 'https://news.example.test/story?id=1&src=rss', title: 'Chips & models', url: 'https://news.example.test/story?id=1&src=rss', summary: '<p>Fish &amp; chips</p>' },
      { external_id: 'tag:news.example.test,2026:att?v=1&r=2', title: 'AT&T signs AI deal', url: 'https://news.example.test/att', summary: null },
      { external_id: 'syndicated-1', title: 'OpenAI & Microsoft update', url: 'https://wire.example.test/update', summary: null },
      { external_id: 'urn:example:e?x=1&y=2', title: 'Atom <b>bold</b> claim', url: 'https://news.example.test/e?a=1&b=2', summary: null },
    ]);
  });
});
