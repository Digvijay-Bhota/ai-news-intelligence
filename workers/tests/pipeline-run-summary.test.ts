/// <reference types="vite/client" />
/**
 * Pipeline-run summaries and stale pipeline-job recovery against a real local
 * D1 binding (Miniflare). Every scheduled run stores a versioned JSON summary
 * in pipeline_jobs.result, so a quiet feed (parsed > 0, inserted = 0) can be
 * told apart from a failed fetch without querying production tables.
 *
 * See source-initialization.test.ts for why `cloudflare:test-internal` is used.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error -- untyped pool runtime module (see header comment)
import { env as workerEnv } from 'cloudflare:test-internal';
import schemaSql from '../../d1/schema.sql?raw';
import { fetchAndIngest } from '../src/tasks/fetcher';
import { runPipeline } from '../src/tasks/orchestrator';
import * as processorModule from '../src/tasks/processor';
import { DbClient } from '../src/db/client';
import { createMockEnv } from './setup';
import type { Source } from '../src/types';

const DB = (workerEnv as unknown as { DB: D1Database }).DB;
const FEED_A = 'https://feeds.example.test/a.xml';
const FEED_B = 'https://feeds.example.test/b.xml';

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

function item(guid: string, title: string, pubDate?: string): string {
  const date = pubDate === undefined ? '' : `<pubDate>${pubDate}</pubDate>`;
  return `<item><title>${title}</title><link>https://news.example.test/${guid}/</link><guid>${guid}</guid>${date}</item>`;
}

/** Serves each feed URL with the given body, or the given HTTP error status. */
function serveFeeds(feeds: Record<string, string | number>): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const feed = feeds[url];
    if (typeof feed === 'number') return new Response('unavailable', { status: feed, statusText: 'Service Unavailable' });
    if (typeof feed === 'string') return new Response(feed, { status: 200 });
    throw new Error(`Unexpected outbound fetch in test: ${url}`);
  }));
}

async function addSource(name: string, feedUrl: string | null): Promise<Source> {
  return (await DB.prepare(
    `INSERT INTO sources (name, feed_url, base_url, source_type, active)
     VALUES (?1, ?2, 'https://news.example.test', 'rss', 1) RETURNING *`
  ).bind(name, feedUrl).first<Source>())!;
}

async function addJob(values: {
  job_type: string; status: string; started_at: number | null; completed_at?: number | null; error_message?: string | null;
}): Promise<number> {
  const row = await DB.prepare(
    `INSERT INTO pipeline_jobs (job_type, status, started_at, completed_at, error_message, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id`
  ).bind(
    values.job_type, values.status, values.started_at, values.completed_at ?? null,
    values.error_message ?? null, values.started_at ?? Math.floor(Date.now() / 1000),
  ).first<{ id: number }>();
  return row!.id;
}

async function job(id: number) {
  return DB.prepare('SELECT * FROM pipeline_jobs WHERE id = ?1').bind(id).first<any>();
}

/** The most recent pipeline-run row and its parsed summary. */
async function latestRun(): Promise<{ row: any; summary: any }> {
  const row = await DB.prepare(
    "SELECT * FROM pipeline_jobs WHERE job_type = 'pipeline-run' ORDER BY id DESC LIMIT 1"
  ).first<any>();
  return { row, summary: row?.result ? JSON.parse(row.result) : null };
}

function sourceEntry(summary: any, sourceId: number) {
  return summary.sources.find((s: any) => s.id === sourceId);
}

const NOW = () => Math.floor(Date.now() / 1000);

describe('Pipeline-run summary (local D1)', () => {
  beforeEach(async () => {
    await run(schemaSql);
    // Keep the seeded starter sources out of these runs.
    await DB.prepare('UPDATE sources SET active = 0').run();
    // Article enrichment is out of scope here; it always succeeds.
    vi.spyOn(processorModule, 'processArticle').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('records per-source ingestion, processing, stale recovery and timestamps as versioned JSON', async () => {
    const busy = await addSource('Busy Feed', FEED_A);
    const unconfigured = await addSource('No Feed Yet', null);
    serveFeeds({
      [FEED_A]: rss(
        item('a-1', 'First story', 'Mon, 05 Oct 2026 10:00:00 GMT'),
        item('a-2', 'Second story', 'Mon, 05 Oct 2026 11:00:00 GMT'),
        item('a-3', 'Story with a broken date', 'not a date'),
      ),
    });
    const stale = await addJob({ job_type: 'pipeline-run', status: 'running', started_at: NOW() - 7200 });

    const before = NOW();
    await runPipeline(createMockEnv({ DB }));
    const after = NOW();

    const { row, summary } = await latestRun();
    expect(row.status).toBe('completed');
    expect(row.error_message).toBeNull();
    expect(summary).toMatchObject({
      version: 1,
      failed_stage: null,
      stale_jobs_recovered: 1,
      processing: { attempted: 3, succeeded: 3, failed: 0, deferred: 0 },
      retries: { attempted: 0, succeeded: 0, failed: 0, deferred: 0 },
      stale_articles_recovered: 0,
      briefs: { state: 'ran', events: 0, generated: 0, failed: 0, deferred: 0, in_progress: 0 },
    });
    expect(summary.started_at).toBeGreaterThanOrEqual(before);
    expect(summary.completed_at).toBeGreaterThanOrEqual(summary.started_at);
    expect(summary.completed_at).toBeLessThanOrEqual(after);

    expect(sourceEntry(summary, busy.id)).toEqual({
      id: busy.id,
      name: 'Busy Feed',
      outcome: 'healthy',
      parsed: 3,
      inserted: 3,
      // The newest valid pubDate; the unparseable one is ignored.
      newest_published_at: Date.UTC(2026, 9, 5, 11) / 1000,
      error: null,
    });
    expect(sourceEntry(summary, unconfigured.id)).toEqual({
      id: unconfigured.id,
      name: 'No Feed Yet',
      outcome: 'unconfigured',
      parsed: null,
      inserted: null,
      newest_published_at: null,
      error: null,
    });
    expect((await job(stale)).status).toBe('failed');
  });

  it('a quiet feed is a successful fetch with parsed > 0 and inserted = 0, not a failure', async () => {
    const quiet = await addSource('Quiet Feed', FEED_A);
    const env = createMockEnv({ DB });
    const feed = rss(
      item('q-1', 'Already seen story', 'Mon, 05 Oct 2026 09:00:00 GMT'),
      item('q-2', 'Also already seen', 'Mon, 05 Oct 2026 09:30:00 GMT'),
    );
    serveFeeds({ [FEED_A]: feed });
    await runPipeline(env); // first run ingests both items

    await runPipeline(env); // same feed again: deduplication skips both

    const { row, summary } = await latestRun();
    expect(row.status).toBe('completed');
    expect(sourceEntry(summary, quiet.id)).toEqual({
      id: quiet.id,
      name: 'Quiet Feed',
      outcome: 'healthy',
      parsed: 2,
      inserted: 0,
      newest_published_at: Date.UTC(2026, 9, 5, 9, 30) / 1000,
      error: null,
    });
    expect(summary.processing).toEqual({ attempted: 0, succeeded: 0, failed: 0, deferred: 0 });
    const articles = await DB.prepare('SELECT COUNT(*) AS n FROM articles_raw WHERE source_id = ?1').bind(quiet.id).first<{ n: number }>();
    expect(articles!.n).toBe(2);
  });

  it('a failed fetch is recorded as down with unknown counts, and source health is unchanged in behavior', async () => {
    const broken = await addSource('Broken Feed', FEED_A);
    const working = await addSource('Working Feed', FEED_B);
    await DB.prepare(
      `INSERT INTO source_health (source_id, status, last_success_at, last_failure_at, consecutive_failures, checked_at)
       VALUES (?1, 'healthy', 1000, NULL, 2, 1000)`
    ).bind(broken.id).run();
    serveFeeds({ [FEED_A]: 503, [FEED_B]: rss(item('w-1', 'Working story', 'Mon, 05 Oct 2026 08:00:00 GMT')) });

    const before = NOW();
    await runPipeline(createMockEnv({ DB }));

    const { row, summary } = await latestRun();
    expect(row.status).toBe('completed');
    const entry = sourceEntry(summary, broken.id);
    expect(entry).toMatchObject({ id: broken.id, name: 'Broken Feed', outcome: 'down', parsed: null, inserted: null, newest_published_at: null });
    expect(entry.error).toContain('Failed to fetch');
    expect(sourceEntry(summary, working.id)).toMatchObject({ outcome: 'healthy', parsed: 1, inserted: 1 });

    const health = await DB.prepare('SELECT * FROM source_health WHERE source_id = ?1').bind(broken.id).first<any>();
    expect(health).toMatchObject({ status: 'down', last_success_at: 1000, consecutive_failures: 3 });
    expect(health.last_failure_at).toBeGreaterThanOrEqual(before);
    expect(health.error_message).toContain('Failed to fetch');
  });

  it('persists the partial summary with the failed stage when a run fails partway', async () => {
    const source = await addSource('Feed Before Failure', FEED_A);
    serveFeeds({ [FEED_A]: rss(item('p-1', 'Story before failure', 'Mon, 05 Oct 2026 07:00:00 GMT')) });
    vi.spyOn(DbClient.prototype, 'listArticles').mockRejectedValue(new Error('D1 unavailable'));

    await expect(runPipeline(createMockEnv({ DB }))).rejects.toThrow('D1 unavailable');

    const { row, summary } = await latestRun();
    expect(row.status).toBe('failed');
    expect(row.error_message).toBe('D1 unavailable');
    expect(row.completed_at).not.toBeNull();
    expect(summary).toMatchObject({
      version: 1,
      failed_stage: 'processing',
      stale_jobs_recovered: 0,
      // Stages that never started are unknown, not zero.
      processing: null,
      retries: null,
      stale_articles_recovered: null,
      briefs: null,
    });
    expect(sourceEntry(summary, source.id)).toMatchObject({ outcome: 'healthy', parsed: 1, inserted: 1 });
  });

  it('fetchAndIngest reports parsed, inserted and the newest valid publication time', async () => {
    const source = await addSource('Direct Feed', FEED_A);
    const env = createMockEnv({ DB });
    serveFeeds({
      [FEED_A]: rss(
        item('d-1', 'Dated story', 'Mon, 05 Oct 2026 06:00:00 GMT'),
        item('d-2', 'Undated story'),
      ),
    });

    expect(await fetchAndIngest(env, source)).toEqual({
      parsed: 2, inserted: 2, newest_published_at: Date.UTC(2026, 9, 5, 6) / 1000,
    });
    expect(await fetchAndIngest(env, source)).toEqual({
      parsed: 2, inserted: 0, newest_published_at: Date.UTC(2026, 9, 5, 6) / 1000,
    });

    serveFeeds({ [FEED_A]: rss(item('d-3', 'Only undated story')) });
    expect(await fetchAndIngest(env, source)).toEqual({ parsed: 1, inserted: 1, newest_published_at: null });
  });
});

describe('Stale pipeline-job recovery (local D1)', () => {
  beforeEach(async () => {
    await run(schemaSql);
    await DB.prepare('UPDATE sources SET active = 0').run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('fails only pipeline-run jobs still running past the timeout', async () => {
    const now = NOW();
    const staleRun = await addJob({ job_type: 'pipeline-run', status: 'running', started_at: now - 1000 });
    const staleNoStart = await addJob({ job_type: 'pipeline-run', status: 'running', started_at: null });
    await DB.prepare('UPDATE pipeline_jobs SET created_at = ?1 WHERE id = ?2').bind(now - 5000, staleNoStart).run();
    const freshRun = await addJob({ job_type: 'pipeline-run', status: 'running', started_at: now - 60 });
    const completed = await addJob({ job_type: 'pipeline-run', status: 'completed', started_at: now - 5000, completed_at: now - 4970 });
    const failed = await addJob({
      job_type: 'pipeline-run', status: 'failed', started_at: now - 5000, completed_at: now - 4990, error_message: 'Original failure',
    });
    const otherType = await addJob({ job_type: 'auth-test', status: 'running', started_at: now - 5000 });

    const recovered = await new DbClient(DB).recoverStalePipelineJobs(900);

    expect(recovered).toBe(2);
    for (const id of [staleRun, staleNoStart]) {
      const row = await job(id);
      expect(row.status).toBe('failed');
      expect(row.completed_at).toBeGreaterThanOrEqual(now);
      expect(row.error_message).toMatch(/still running after 900s/);
      // The run never recorded a summary, so none is invented.
      expect(row.result).toBeNull();
    }
    expect(await job(freshRun)).toMatchObject({ status: 'running', completed_at: null, error_message: null });
    expect(await job(completed)).toMatchObject({ status: 'completed', completed_at: now - 4970, error_message: null });
    expect(await job(failed)).toMatchObject({ status: 'failed', completed_at: now - 4990, error_message: 'Original failure' });
    expect(await job(otherType)).toMatchObject({ status: 'running', completed_at: null, error_message: null });
  });

  it('a run recovers earlier stale runs but never its own job', async () => {
    const stale = await addJob({ job_type: 'pipeline-run', status: 'running', started_at: NOW() - 3600 });

    await runPipeline(createMockEnv({ DB }));

    const { row, summary } = await latestRun();
    expect(row.id).not.toBe(stale);
    expect(row.status).toBe('completed');
    expect(summary.stale_jobs_recovered).toBe(1);
    expect((await job(stale)).status).toBe('failed');
  });

  it('a recovery failure fails the run through normal finalization', async () => {
    vi.spyOn(DbClient.prototype, 'recoverStalePipelineJobs').mockRejectedValue(new Error('recovery broke'));

    await expect(runPipeline(createMockEnv({ DB }))).rejects.toThrow('recovery broke');

    const { row, summary } = await latestRun();
    expect(row).toMatchObject({ status: 'failed', error_message: 'recovery broke' });
    expect(summary).toMatchObject({ failed_stage: 'recovery', stale_jobs_recovered: null, sources: [] });
  });
});

describe('Pipeline-job result persistence (local D1)', () => {
  beforeEach(async () => {
    await run(schemaSql);
  });

  it('createPipelineJob stores the result column', async () => {
    const created = await new DbClient(DB).createPipelineJob({
      job_type: 'log-test', status: 'completed', payload: null, result: '{"ok":true}', error_message: null,
    });
    expect((await job(created.id)).result).toBe('{"ok":true}');
  });

  it('updatePipelineJobStatus stores a result and keeps an existing one when none is given', async () => {
    const client = new DbClient(DB);
    const created = await client.createPipelineJob({
      job_type: 'pipeline-run', status: 'running', payload: null, result: null, error_message: null,
    });

    await client.updatePipelineJobStatus(created.id, 'running', null, '{"version":1}');
    expect((await job(created.id)).result).toBe('{"version":1}');

    await client.updatePipelineJobStatus(created.id, 'completed');
    expect(await job(created.id)).toMatchObject({ status: 'completed', result: '{"version":1}' });
  });
});
