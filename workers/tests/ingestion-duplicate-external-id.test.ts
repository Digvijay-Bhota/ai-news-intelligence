/// <reference types="vite/client" />
/**
 * Regression: a feed item whose title is edited but whose external_id (guid) is
 * unchanged must not abort ingestion. Runs against a real local D1 binding
 * (Miniflare) so the articles_raw.external_id UNIQUE constraint is enforced.
 *
 * See source-initialization.test.ts for why `cloudflare:test-internal` is used.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error -- untyped pool runtime module (see header comment)
import { env as workerEnv } from 'cloudflare:test-internal';
import schemaSql from '../../d1/schema.sql?raw';
import { fetchAndIngest } from '../src/tasks/fetcher';
import { runPipeline } from '../src/tasks/orchestrator';
import { createMockEnv } from './setup';
import type { Source } from '../src/types';

const DB = (workerEnv as unknown as { DB: D1Database }).DB;
const FEED_URL = 'https://feeds.example.test/duplicate-external-id.xml';

function splitSql(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^PRAGMA\b/i.test(s));
}

async function run(sql: string): Promise<void> {
  for (const stmt of splitSql(sql)) {
    await DB.prepare(stmt).run();
  }
}

function item(guid: string, title: string, slug: string): string {
  return `<item><title>${title}</title><link>https://news.example.test/${slug}/</link>`
    + `<guid>${guid}</guid><description>Summary of ${slug}</description></item>`;
}

function rss(...items: string[]): string {
  return `<rss version="2.0"><channel>${items.join('')}</channel></rss>`;
}

// The first fetch sees only the original story.
const FIRST_FEED = rss(item('dup-x', 'Original title', 'story-x'));
// An hour later: a new story on top, the original story with an edited title,
// and a previously unseen story after it.
const SECOND_FEED = rss(
  item('dup-new', 'Brand new story', 'story-new'),
  item('dup-x', 'Original title (updated)', 'story-x'),
  item('dup-after', 'Unseen story after the edited one', 'story-after'),
);

function serveFeed(xml: string): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === FEED_URL) return new Response(xml, { status: 200 });
    // Other seeded feeds and Gemini never reach the network.
    throw new Error(`Unexpected outbound fetch in test: ${url}`);
  }));
}

async function article(externalId: string) {
  return DB.prepare('SELECT * FROM articles_raw WHERE external_id = ?1').bind(externalId).first<any>();
}

describe('Ingestion with an edited title and an unchanged external_id (local D1)', () => {
  let source: Source;

  beforeEach(async () => {
    await run(schemaSql);
    source = (await DB.prepare(
      `INSERT INTO sources (name, feed_url, base_url, source_type, active)
       VALUES ('Duplicate ID Regression Feed', ?1, 'https://news.example.test', 'rss', 1)
       ON CONFLICT(name) DO UPDATE SET feed_url = excluded.feed_url
       RETURNING *`
    ).bind(FEED_URL).first<Source>())!;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('skips the existing article and still stores the stories around it', async () => {
    const env = createMockEnv({ DB });

    serveFeed(FIRST_FEED);
    expect(await fetchAndIngest(env, source)).toBe(1);
    const original = await article('dup-x');
    expect(original).toMatchObject({ title: 'Original title', source_id: source.id });

    serveFeed(SECOND_FEED);
    await expect(fetchAndIngest(env, source)).resolves.toBe(2);

    expect(await article('dup-new')).toMatchObject({ title: 'Brand new story', source_id: source.id, status: 'pending' });
    expect(await article('dup-after')).toMatchObject({
      title: 'Unseen story after the edited one',
      source_id: source.id,
      status: 'pending',
    });
    // The existing row is left exactly as it was, including its original title.
    expect(await article('dup-x')).toEqual(original);
  });

  it('runPipeline keeps the source healthy when the feed repeats an edited item', async () => {
    const env = createMockEnv({ DB });

    serveFeed(FIRST_FEED);
    expect(await fetchAndIngest(env, source)).toBe(1);

    serveFeed(SECOND_FEED);
    await runPipeline(env);

    const health = await DB.prepare('SELECT * FROM source_health WHERE source_id = ?1').bind(source.id).first<any>();
    expect(health).toMatchObject({ status: 'healthy', consecutive_failures: 0, error_message: null });
    expect(await article('dup-after')).not.toBeNull();
  });
});
