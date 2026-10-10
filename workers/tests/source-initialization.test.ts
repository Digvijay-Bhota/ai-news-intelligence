/// <reference types="vite/client" />
/**
 * Starter source initialization against a real local D1 binding (Miniflare).
 *
 * Fresh databases get feed URLs from the schema.sql seed; existing databases
 * get them from migration 0012, which only fills empty/NULL feed URLs.
 *
 * vitest.config.ts uses plain defineConfig (not defineWorkersConfig), so the
 * `cloudflare:test` alias is not registered. `cloudflare:test-internal` is the
 * pool's runtime module that `cloudflare:test` re-exports `env` from.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
// @ts-expect-error -- untyped pool runtime module (see header comment)
import { env as workerEnv } from 'cloudflare:test-internal';
import schemaSql from '../../d1/schema.sql?raw';
import backfillSql from '../../d1/migrations/0012_seed_source_feed_urls.sql?raw';
import { fetchAndIngest } from '../src/tasks/fetcher';
import { createMockEnv } from './setup';
import type { Source } from '../src/types';

const DB = (workerEnv as unknown as { DB: D1Database }).DB;

const EXPECTED_FEEDS: Record<string, string | null> = {
  'TechCrunch': 'https://techcrunch.com/feed/',
  'The Verge': 'https://www.theverge.com/rss/index.xml',
  'Ars Technica': null, // unverified; intentionally left unset
};

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

async function sources(): Promise<Source[]> {
  return (await DB.prepare('SELECT * FROM sources ORDER BY id').all<Source>()).results;
}

function withoutTimestamps(rows: Source[]) {
  return rows.map(({ updated_at: _u, created_at: _c, ...rest }) => rest);
}

describe('Starter source initialization (local D1)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fresh schema seeds the starter sources with verified HTTPS feed URLs', async () => {
    await run(schemaSql);
    const rows = await sources();

    expect(rows.map((r) => r.name).sort()).toEqual(Object.keys(EXPECTED_FEEDS).sort());
    for (const row of rows) {
      expect(row.feed_url).toBe(EXPECTED_FEEDS[row.name]);
      if (row.feed_url) expect(new URL(row.feed_url).protocol).toBe('https:');
      expect(row).toMatchObject({ source_type: 'rss', active: 1, reliability_score: 0.5, fetch_interval_minutes: 60 });
    }
  });

  it('re-running schema.sql and the backfill creates no duplicates and changes nothing', async () => {
    await run(schemaSql);
    await run(backfillSql);
    const first = await sources();

    await run(schemaSql);
    await run(backfillSql);
    await run(backfillSql);
    const second = await sources();

    expect(second).toHaveLength(3);
    expect(withoutTimestamps(second)).toEqual(withoutTimestamps(first));
  });

  it('backfill repairs legacy rows seeded without feed URLs and leaves other settings unchanged', async () => {
    await run(schemaSql);
    // Recreate the legacy state: rows exist, feed URLs missing or blank, with some customized settings.
    await DB.prepare("UPDATE sources SET feed_url = NULL, fetch_interval_minutes = 15, reliability_score = 0.9 WHERE name = 'TechCrunch'").run();
    await DB.prepare("UPDATE sources SET feed_url = '   ', active = 0 WHERE name = 'The Verge'").run();
    await DB.prepare("UPDATE sources SET feed_url = NULL WHERE name = 'Ars Technica'").run();
    const before = await sources();

    await run(backfillSql);
    const after = await sources();

    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    for (const row of after) {
      expect(row.feed_url).toBe(EXPECTED_FEEDS[row.name]);
      const prev = before.find((b) => b.id === row.id)!;
      const { feed_url: _a, updated_at: _b, ...rest } = row;
      const { feed_url: _c, updated_at: _d, ...prevRest } = prev;
      expect(rest).toEqual(prevRest);
    }
  });

  it('backfill preserves customized non-empty feed URLs', async () => {
    await run(schemaSql);
    await DB.prepare("UPDATE sources SET feed_url = 'https://feeds.example.test/custom-techcrunch.xml' WHERE name = 'TechCrunch'").run();
    await DB.prepare("UPDATE sources SET feed_url = NULL WHERE name = 'The Verge'").run();

    await run(backfillSql);
    await run(backfillSql);

    const byName = Object.fromEntries((await sources()).map((r) => [r.name, r.feed_url]));
    expect(byName['TechCrunch']).toBe('https://feeds.example.test/custom-techcrunch.xml');
    expect(byName['The Verge']).toBe(EXPECTED_FEEDS['The Verge']);
  });

  it('seeded sources are ingestible: fetcher uses the seeded URL and skips the unset one', async () => {
    await run(schemaSql);
    const fixture = `<rss version="2.0"><channel>
      <item><title>Seed fixture story</title><link>https://techcrunch.com/2026/10/01/seed-fixture/</link>
      <guid>seed-fixture-1</guid><description>Fixture</description><pubDate>Thu, 01 Oct 2026 09:00:00 GMT</pubDate></item>
    </channel></rss>`;
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === EXPECTED_FEEDS['TechCrunch']) return new Response(fixture, { status: 200 });
      throw new Error(`Unexpected outbound fetch in test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchStub);
    const env = createMockEnv({ DB });

    const rows = await sources();
    const techcrunch = rows.find((r) => r.name === 'TechCrunch')!;
    const ars = rows.find((r) => r.name === 'Ars Technica')!;

    expect(await fetchAndIngest(env, techcrunch)).toBe(1);
    expect(await fetchAndIngest(env, ars)).toBe(0);
    expect(fetchStub).toHaveBeenCalledTimes(1);

    const article = await DB.prepare('SELECT * FROM articles_raw WHERE external_id = ?1').bind('seed-fixture-1').first<any>();
    expect(article).toMatchObject({ source_id: techcrunch.id, status: 'pending', title: 'Seed fixture story' });
  });
});
