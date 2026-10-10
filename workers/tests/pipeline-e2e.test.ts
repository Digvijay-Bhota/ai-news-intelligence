/// <reference types="vite/client" />
/**
 * Pipeline end-to-end test against a real local D1 binding (Miniflare).
 *
 * Schema comes from d1/schema.sql. Outbound fetch is fully stubbed: the RSS
 * feed returns a fixture and Gemini returns canned JSON. Any other URL fails.
 *
 * vitest.config.ts uses plain defineConfig (not defineWorkersConfig), so the
 * `cloudflare:test` alias is not registered. `cloudflare:test-internal` is the
 * pool's runtime module that `cloudflare:test` re-exports `env` from.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error -- untyped pool runtime module (see header comment)
import { env as workerEnv } from 'cloudflare:test-internal';
import schemaSql from '../../d1/schema.sql?raw';
import { runPipeline } from '../src/tasks/orchestrator';
import { route } from '../src/router';
import { buildSignedRequest } from '../src/utils/hmac';
import { createMockEnv, TEST_SECRET } from './setup';
import type { Env } from '../src/types';

const FEED_URL = 'https://feeds.e2e.test/rss.xml';
const GEMINI_HOST = 'generativelanguage.googleapis.com';

const EVENT = {
  title: 'Acme releases open-weight model',
  description: 'Acme Labs published an open-weight language model.',
  severity: 'high',
};

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>E2E Wire</title>
  <item>
    <title>Acme releases open-weight model</title>
    <link>https://news.e2e.test/acme-model</link>
    <guid>e2e-guid-1</guid>
    <description>Acme Labs today published an open-weight model.</description>
    <pubDate>Mon, 05 Oct 2026 10:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Analysts react to Acme model release</title>
    <link>https://news.e2e.test/acme-reaction</link>
    <guid>e2e-guid-2</guid>
    <description>Analysts weigh in on the Acme Labs release.</description>
    <pubDate>Mon, 05 Oct 2026 11:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

function geminiReply(payload: unknown, status = 200): Response {
  if (status !== 200) return new Response('stubbed', { status, statusText: 'Stubbed' });
  return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] });
}

interface FetchLog { feed: number; enrichment: number; match: number; otherGemini: number }

function installFetchStub(log: FetchLog) {
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === FEED_URL) {
      log.feed++;
      return new Response(RSS_FIXTURE, { status: 200, headers: { 'Content-Type': 'application/rss+xml' } });
    }
    if (new URL(url).host === GEMINI_HOST) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const prompt: string = body.contents?.[0]?.parts?.[0]?.text ?? '';
      if (prompt.startsWith('Analyze this article')) {
        log.enrichment++;
        return geminiReply({ summary: 'Acme Labs released an open-weight model.', topics: ['Open Models'], events: [EVENT] });
      }
      if (prompt.includes('semantic event matching engine')) {
        log.match++;
        const id = Number(prompt.match(/ID: (\d+) \| Title: Acme releases open-weight model/)?.[1]);
        return geminiReply(Number.isInteger(id) ? { match: true, event_id: id } : { match: false, event_id: null });
      }
      // Brief / claim-comparison stages are out of scope: fail fast with a non-retryable status.
      log.otherGemini++;
      return geminiReply(null, 400);
    }
    throw new Error(`Unexpected outbound fetch in e2e test: ${url}`);
  });
  vi.stubGlobal('fetch', stub);
}

function splitSchema(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^PRAGMA\b/i.test(s));
}

async function count(db: D1Database, sql: string, ...params: unknown[]): Promise<number> {
  const row = await db.prepare(sql).bind(...params).first<{ n: number }>();
  return row?.n ?? 0;
}

async function signedGet(path: string): Promise<Request> {
  const ts = Math.floor(Date.now() / 1000);
  const req = new Request(`http://localhost${path}`, { method: 'GET', headers: { 'Content-Type': 'application/json' } });
  return buildSignedRequest(req, TEST_SECRET, `e2e-nonce-${ts}-${Math.random()}`, ts);
}

describe('Pipeline E2E (local D1)', () => {
  const bindings = workerEnv as unknown as { DB: D1Database; CACHE: KVNamespace };
  let env: Env;
  let log: FetchLog;

  beforeAll(async () => {
    for (const stmt of splitSchema(schemaSql)) {
      await bindings.DB.prepare(stmt).run();
    }
    await bindings.DB
      .prepare('INSERT INTO sources (name, feed_url, base_url, source_type, active) VALUES (?1, ?2, ?3, ?4, 1)')
      .bind('E2E Wire', FEED_URL, 'https://news.e2e.test', 'rss')
      .run();
  });

  beforeEach(() => {
    env = createMockEnv({ DB: bindings.DB, CACHE: bindings.CACHE });
    log = { feed: 0, enrichment: 0, match: 0, otherGemini: 0 };
    installFetchStub(log);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ingests, enriches, clusters and serves articles through the API', async () => {
    const db = bindings.DB;
    expect(await count(db, 'SELECT COUNT(*) AS n FROM articles_raw')).toBe(0);

    await runPipeline(env);

    expect(log.feed).toBe(1);
    expect(log.enrichment).toBe(2);
    expect(log.match).toBe(1); // second article is matched against the event created by the first

    // Articles stored and processed
    const articles = (await db.prepare('SELECT * FROM articles_raw ORDER BY external_id').all<any>()).results;
    expect(articles.map((a) => a.external_id)).toEqual(['e2e-guid-1', 'e2e-guid-2']);
    expect(articles.every((a) => a.status === 'processed')).toBe(true);
    expect(await count(db, 'SELECT COUNT(*) AS n FROM article_content')).toBe(2);
    expect(await count(db, 'SELECT COUNT(*) AS n FROM dedup_hashes')).toBe(2);

    // One event, both articles linked to it
    const events = (await db.prepare('SELECT * FROM events').all<any>()).results;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ title: EVENT.title, severity: EVENT.severity, status: 'active' });
    expect(await count(db, 'SELECT COUNT(*) AS n FROM article_events WHERE event_id = ?1', events[0].id)).toBe(2);

    // Topic created and linked
    const topic = await db.prepare('SELECT * FROM topics WHERE slug = ?1').bind('open-models').first<any>();
    expect(topic).not.toBeNull();
    expect(await count(db, 'SELECT COUNT(*) AS n FROM article_topics WHERE topic_id = ?1', topic.id)).toBe(2);

    // ai_jobs: one completed enrichment job per article
    const jobs = (await db.prepare("SELECT * FROM ai_jobs WHERE job_type = 'enrichment' ORDER BY article_raw_id").all<any>()).results;
    expect(jobs.map((j) => j.article_raw_id)).toEqual(articles.map((a) => a.id));
    expect(jobs.every((j) => j.status === 'completed' && j.error_message === null)).toBe(true);
    expect(JSON.parse(jobs[0].result).events[0].title).toBe(EVENT.title);

    // Pipeline run and source health recorded
    const run = await db.prepare("SELECT * FROM pipeline_jobs WHERE job_type = 'pipeline-run'").first<any>();
    expect(run.status).toBe('completed');
    // Other seeded sources also get health rows (e.g. 'unconfigured' when they have no feed URL).
    const e2eSource = await db.prepare("SELECT id FROM sources WHERE name = 'E2E Wire'").first<{ id: number }>();
    const health = await db.prepare('SELECT * FROM source_health WHERE source_id = ?1').bind(e2eSource!.id).first<any>();
    expect(health).toMatchObject({ source_id: e2eSource!.id, status: 'healthy', consecutive_failures: 0 });

    // Feed API
    const feedRes = await route(await signedGet('/api/v1/feed'), env);
    expect(feedRes.status).toBe(200);
    const feed = (await feedRes.json()) as any;
    expect(feed.data.meta.total).toBe(2);
    const feedTitles = feed.data.items.map((i: any) => i.title).sort();
    expect(feedTitles).toEqual(['Acme releases open-weight model', 'Analysts react to Acme model release']);
    expect(feed.data.items.every((i: any) => i.source === 'E2E Wire')).toBe(true);

    // Events list API
    const eventsRes = await route(await signedGet('/api/v1/events'), env);
    expect(eventsRes.status).toBe(200);
    const eventsBody = (await eventsRes.json()) as any;
    expect(eventsBody.data.items).toHaveLength(1);
    expect(eventsBody.data.items[0]).toMatchObject({ hash: events[0].event_hash, title: EVENT.title, article_count: 2 });

    // Event detail API
    const detailRes = await route(await signedGet(`/api/v1/events/${events[0].event_hash}`), env);
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as any;
    expect(JSON.stringify(detail.data)).toContain('Analysts react to Acme model release');
  });

  it('does not re-ingest or re-process articles on a second run (dedup)', async () => {
    const db = bindings.DB;
    expect(await count(db, 'SELECT COUNT(*) AS n FROM articles_raw')).toBe(0);

    await runPipeline(env);
    await runPipeline(env);

    expect(log.feed).toBe(2);
    expect(log.enrichment).toBe(2);
    expect(await count(db, 'SELECT COUNT(*) AS n FROM articles_raw')).toBe(2);
    expect(await count(db, 'SELECT COUNT(*) AS n FROM dedup_hashes')).toBe(2);
    expect(await count(db, 'SELECT COUNT(*) AS n FROM events')).toBe(1);
    expect(await count(db, "SELECT COUNT(*) AS n FROM ai_jobs WHERE job_type = 'enrichment'")).toBe(2);
    expect(await count(db, "SELECT COUNT(*) AS n FROM pipeline_jobs WHERE job_type = 'pipeline-run' AND status = 'completed'")).toBe(2);
  });
});
