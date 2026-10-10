/// <reference types="vite/client" />
/**
 * Source health for sources without a feed URL, against a real local D1 binding
 * (Miniflare). A source whose feed_url is NULL, empty or whitespace-only is never
 * fetched, so the pipeline must not record it as a successful fetch.
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
const FEED_URL = 'https://feeds.example.test/configured.xml';

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

function rss(...items: string[]): string {
  return `<rss version="2.0"><channel>${items.join('')}</channel></rss>`;
}

function item(guid: string, title: string): string {
  return `<item><title>${title}</title><link>https://news.example.test/${guid}/</link><guid>${guid}</guid></item>`;
}

let fetchStub: ReturnType<typeof vi.fn>;

function serveFeed(xml: string): void {
  fetchStub = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === FEED_URL) return new Response(xml, { status: 200 });
    // Gemini and anything else never reach the network.
    throw new Error(`Unexpected outbound fetch in test: ${url}`);
  });
  vi.stubGlobal('fetch', fetchStub);
}

function feedRequests(): string[] {
  return fetchStub.mock.calls
    .map(([input]) => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url))
    .filter((url) => !url.includes('generativelanguage'));
}

async function addSource(name: string, feedUrl: string | null): Promise<Source> {
  return (await DB.prepare(
    `INSERT INTO sources (name, feed_url, base_url, source_type, active)
     VALUES (?1, ?2, 'https://news.example.test', 'rss', 1) RETURNING *`
  ).bind(name, feedUrl).first<Source>())!;
}

async function setHealth(sourceId: number, values: {
  status: string; last_success_at: number | null; last_failure_at: number | null; consecutive_failures: number;
}): Promise<void> {
  await DB.prepare(
    `INSERT INTO source_health (source_id, status, last_success_at, last_failure_at, consecutive_failures, checked_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 1000)`
  ).bind(sourceId, values.status, values.last_success_at, values.last_failure_at, values.consecutive_failures).run();
}

async function health(sourceId: number) {
  return DB.prepare('SELECT * FROM source_health WHERE source_id = ?1').bind(sourceId).first<any>();
}

describe('Source health for sources without a feed URL (local D1)', () => {
  beforeEach(async () => {
    await run(schemaSql);
    // Keep the seeded starter sources out of these runs.
    await DB.prepare('UPDATE sources SET active = 0').run();
    serveFeed(rss());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('NULL feed URL: not marked healthy and last_success_at is not advanced', async () => {
    const source = await addSource('No Feed', null);
    // A row left behind by an earlier run that wrongly recorded a success.
    await setHealth(source.id, { status: 'healthy', last_success_at: 1000, last_failure_at: 900, consecutive_failures: 0 });

    await runPipeline(createMockEnv({ DB }));

    expect(await health(source.id)).toMatchObject({
      status: 'unconfigured',
      last_success_at: 1000,
      last_failure_at: 900,
      consecutive_failures: 0,
      error_message: 'No feed URL configured',
    });
    expect(feedRequests()).toEqual([]);
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('%s feed URL is treated like NULL and never fetched', async (_label, feedUrl) => {
    const source = await addSource(`Blank Feed (${_label})`, feedUrl);
    await setHealth(source.id, { status: 'down', last_success_at: null, last_failure_at: 900, consecutive_failures: 2 });

    expect(await fetchAndIngest(createMockEnv({ DB }), source)).toBe(0);
    await runPipeline(createMockEnv({ DB }));

    expect(await health(source.id)).toMatchObject({
      status: 'unconfigured',
      last_success_at: null,
      last_failure_at: 900,
      consecutive_failures: 2, // no request was made, so no new failure is counted
      error_message: 'No feed URL configured',
    });
    expect(feedRequests()).toEqual([]);
  });

  it('a source with no health row yet is recorded as unconfigured, not healthy', async () => {
    const source = await addSource('Brand New Unconfigured', null);

    await runPipeline(createMockEnv({ DB }));

    expect(await health(source.id)).toMatchObject({
      status: 'unconfigured',
      last_success_at: null,
      last_failure_at: null,
      consecutive_failures: 0,
    });
  });

  it('configured feed with zero new items is still a successful fetch', async () => {
    const source = await addSource('Configured Quiet Feed', FEED_URL);
    const env = createMockEnv({ DB });
    const feed = rss(item('quiet-1', 'Already seen story'));
    serveFeed(feed);
    expect(await fetchAndIngest(env, source)).toBe(1);
    await setHealth(source.id, { status: 'down', last_success_at: 1000, last_failure_at: 900, consecutive_failures: 3 });
    serveFeed(feed); // fresh stub so only the pipeline's request is counted

    const before = Math.floor(Date.now() / 1000);
    await runPipeline(env); // same feed again: nothing new to ingest

    const row = await health(source.id);
    expect(row).toMatchObject({ status: 'healthy', last_failure_at: 900, consecutive_failures: 0, error_message: null });
    expect(row.last_success_at).toBeGreaterThanOrEqual(before);
    expect(feedRequests()).toEqual([FEED_URL]);
  });

  it('configured feed ingests articles and is healthy alongside an unconfigured source', async () => {
    const configured = await addSource('Configured Feed', FEED_URL);
    const unconfigured = await addSource('Unconfigured Feed', null);
    serveFeed(rss(item('live-1', 'First live story'), item('live-2', 'Second live story')));

    const before = Math.floor(Date.now() / 1000);
    await runPipeline(createMockEnv({ DB }));

    const stored = await DB.prepare('SELECT external_id FROM articles_raw WHERE source_id = ?1 ORDER BY external_id')
      .bind(configured.id).all<{ external_id: string }>();
    expect(stored.results.map((r) => r.external_id)).toEqual(['live-1', 'live-2']);

    const row = await health(configured.id);
    expect(row).toMatchObject({ status: 'healthy', consecutive_failures: 0, error_message: null });
    expect(row.last_success_at).toBeGreaterThanOrEqual(before);
    expect(await health(unconfigured.id)).toMatchObject({ status: 'unconfigured', last_success_at: null });
    expect(feedRequests()).toEqual([FEED_URL]);
  });
});
