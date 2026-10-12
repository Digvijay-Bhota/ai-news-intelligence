/// <reference types="vite/client" />
/**
 * Article image fields on public API responses, against an isolated local D1
 * and KV (Miniflare): additive response shape, response-time re-validation
 * after cache reads, and image-free internal ingestion.
 *
 * See pipeline-e2e.test.ts for why `cloudflare:test-internal` is imported.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error -- untyped pool runtime module (see pipeline-e2e.test.ts)
import { env as workerEnv } from 'cloudflare:test-internal';
import schemaSql from '../../d1/schema.sql?raw';
import { route } from '../src/router';
import { buildSignedRequest, sha256Hex } from '../src/utils/hmac';
import { generateCacheKey } from '../src/utils/cache';
import { createMockEnv, TEST_SECRET } from './setup';
import type { Env } from '../src/types';

const bindings = workerEnv as unknown as { DB: D1Database; CACHE: KVNamespace };
const DB = bindings.DB;
const VERGE_IMAGE = 'https://platform.theverge.com/uploads/photo.jpg';
const REVOKED_IMAGE = 'https://images.revoked.example/photo.jpg';
const EVENT_HASH = 'image-api-event';
const NULLS = { image_url: null, image_credit: null };

// id, source name, stored image_url, stored image_credit, published_at
const ARTICLES: [number, string, string | null, string | null, number][] = [
  [1, 'The Verge', VERGE_IMAGE, 'Verge Photo Desk', 1760005000],
  [2, 'The Verge', null, null, 1760004000], // legacy row
  [3, 'TechCrunch', VERGE_IMAGE, 'Desk', 1760003000], // host approved only for The Verge
  [4, 'The Verge', 'http://platform.theverge.com/a.jpg', 'Desk', 1760002000],
  [5, 'The Verge', 'https://user:pass@platform.theverge.com/a.jpg', 'Desk', 1760001000],
];
const EXPECTED: Record<number, { image_url: string | null; image_credit: string | null }> = {
  1: { image_url: VERGE_IMAGE, image_credit: 'Verge Photo Desk' }, 2: NULLS, 3: NULLS, 4: NULLS, 5: NULLS,
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

let nonce = 0;
async function get(path: string, env: Env): Promise<any> {
  const ts = Math.floor(Date.now() / 1000);
  const req = await buildSignedRequest(new Request(`http://localhost${path}`, { method: 'GET' }), TEST_SECRET, `img-api-${++nonce}`, ts);
  const res = await route(req, env);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: any }).data;
}

const imagesById = (items: any[]) =>
  Object.fromEntries(items.map(i => [i.id, { image_url: i.image_url, image_credit: i.image_credit }]));

async function tamperCache(key: string, edit: (value: any) => void): Promise<void> {
  const value = JSON.parse((await bindings.CACHE.get(key))!);
  edit(value);
  await bindings.CACHE.put(key, JSON.stringify(value), { expirationTtl: 300 });
}

describe('Article image fields on API responses (local D1)', () => {
  let env: Env;

  beforeEach(async () => {
    for (const stmt of splitSql(schemaSql)) await DB.prepare(stmt).run();
    for (const [id, source, imageUrl, imageCredit, publishedAt] of ARTICLES) {
      await DB.prepare(`INSERT INTO articles_raw (id, external_id, source_id, title, summary, url, raw_content, published_at, status, image_url, image_credit)
        VALUES (?1, ?2, (SELECT id FROM sources WHERE name = ?3), ?4, 'Summary', ?5, '<item/>', ?6, 'processed', ?7, ?8)`)
        .bind(id, `ext-${id}`, source, `Story ${id}`, `https://news.example.test/${id}`, publishedAt, imageUrl, imageCredit).run();
    }
    await DB.prepare("INSERT INTO events (id, event_hash, title, severity, started_at) VALUES (1, ?1, 'Image API event', 'medium', 1760000000)").bind(EVENT_HASH).run();
    for (const [id] of ARTICLES) {
      await DB.prepare('INSERT INTO article_events (article_raw_id, event_id) VALUES (?1, 1)').bind(id).run();
    }
    env = createMockEnv({ DB, CACHE: bindings.CACHE });
  });

  it('adds re-validated image fields to feed items without changing other fields, order or pagination', async () => {
    const feed = await get('/api/v1/feed', env);
    expect(feed.meta).toEqual({ limit: 20, offset: 0, total: 5 });
    expect(feed.items.map((i: any) => i.id)).toEqual([1, 2, 3, 4, 5]);
    expect(imagesById(feed.items)).toEqual(EXPECTED);
    expect(feed.items[0]).toMatchObject({ external_id: 'ext-1', title: 'Story 1', url: 'https://news.example.test/1', source: 'The Verge', category: null, topics: [] });
    expect(feed.items[0].events).toEqual([{ title: 'Image API event', hash: EVENT_HASH }]);

    const page = await get('/api/v1/feed?limit=2&offset=2', env);
    expect(page.meta).toEqual({ limit: 2, offset: 2, total: 5 });
    expect(page.items.map((i: any) => i.id)).toEqual([3, 4]);
  });

  it('adds re-validated image fields to event-detail articles and article detail', async () => {
    const detail = await get(`/api/v1/events/${EVENT_HASH}`, env);
    expect(detail.event.hash).toBe(EVENT_HASH);
    expect(detail.coverage.total_articles).toBe(5);
    expect(imagesById(detail.articles)).toEqual(EXPECTED);

    for (const [id] of ARTICLES) {
      const article = await get(`/api/v1/articles/${id}`, env);
      expect({ image_url: article.image_url, image_credit: article.image_credit }).toEqual(EXPECTED[id]);
      expect(article).toMatchObject({ id, title: `Story ${id}`, external_id: `ext-${id}` });
    }
  });

  it('re-validates feed items after the cache read: revoked hosts and old cache entries return nulls', async () => {
    const before = await get('/api/v1/feed', env);
    const key = generateCacheKey('feed', { limit: 20, offset: 0 });
    await tamperCache(key, (cached) => {
      cached.total = 99; // proves the response below is served from this cache entry
      cached.items[0].image_url = REVOKED_IMAGE; // cached while its host was still allowed
      delete cached.items[1].image_url; // entry cached before Phase 2
      delete cached.items[1].image_credit;
    });

    const after = await get('/api/v1/feed', env);
    expect(after.meta.total).toBe(99);
    expect(after.items[0]).toEqual({ ...before.items[0], ...NULLS });
    expect(after.items[1]).toEqual({ ...before.items[1], ...NULLS });
    expect(after.items.slice(2)).toEqual(before.items.slice(2));
  });

  it('re-validates event-detail and article-detail responses after the cache read', async () => {
    await get(`/api/v1/events/${EVENT_HASH}`, env);
    await tamperCache(generateCacheKey('event_detail', { hash: EVENT_HASH }), (cached) => {
      cached.articles.find((a: any) => a.id === 1).image_url = REVOKED_IMAGE;
    });
    const detail = await get(`/api/v1/events/${EVENT_HASH}`, env);
    expect(imagesById(detail.articles)[1]).toEqual(NULLS);

    await get('/api/v1/articles/1', env);
    await tamperCache(generateCacheKey('article_detail', { id: 1 }), (cached) => {
      cached.image_url = REVOKED_IMAGE;
      cached.title = 'Served from cache';
    });
    const article = await get('/api/v1/articles/1', env);
    expect(article).toMatchObject({ title: 'Served from cache', ...NULLS });
  });

  it('keeps the existing cache TTLs (feed 60s, event and article detail 300s)', async () => {
    const now = Math.floor(Date.now() / 1000);
    await get('/api/v1/feed', env);
    await get(`/api/v1/events/${EVENT_HASH}`, env);
    await get('/api/v1/articles/1', env);
    const ttl = async (key: string) => {
      const { keys } = await bindings.CACHE.list({ prefix: key });
      const entry = keys.find(k => k.name === key);
      return (entry?.expiration ?? 0) - now;
    };
    expect(await ttl(generateCacheKey('feed', { limit: 20, offset: 0 }))).toBeGreaterThanOrEqual(58);
    expect(await ttl(generateCacheKey('feed', { limit: 20, offset: 0 }))).toBeLessThanOrEqual(61);
    for (const key of [generateCacheKey('event_detail', { hash: EVENT_HASH }), generateCacheKey('article_detail', { id: 1 })]) {
      expect(await ttl(key)).toBeGreaterThanOrEqual(298);
      expect(await ttl(key)).toBeLessThanOrEqual(301);
    }
  });

  it('ignores caller-supplied image fields on internal ingestion and does not return image keys', async () => {
    await DB.prepare("INSERT INTO pipeline_tokens (token_id, token_secret_hash, name, scopes, active) VALUES ('tok-img', ?1, 'tok-img', 'internal,admin', 1)")
      .bind(await sha256Hex('img-secret')).run();
    const verge = await DB.prepare("SELECT id FROM sources WHERE name = 'The Verge'").first<{ id: number }>();
    const body = {
      external_id: 'manual-1',
      source_id: verge!.id,
      title: 'Manual article',
      url: 'https://news.example.test/manual',
      raw_content: `<item><media:content url="${VERGE_IMAGE}" medium="image"/></item>`,
      image_url: VERGE_IMAGE,
      image_credit: 'Caller credit',
    };
    const ts = Math.floor(Date.now() / 1000);
    const req = await buildSignedRequest(new Request('http://localhost/internal/v1/articles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Token-ID': 'tok-img', 'X-Token-Secret': 'img-secret' },
      body: JSON.stringify(body),
    }), TEST_SECRET, `img-internal-${++nonce}`, ts);

    const res = await route(req, env);
    expect(res.status).toBe(201);
    const created = ((await res.json()) as { data: Record<string, unknown> }).data;
    expect(created).toMatchObject({ external_id: 'manual-1', title: 'Manual article' });
    expect(created).not.toHaveProperty('image_url');
    expect(created).not.toHaveProperty('image_credit');

    const stored = await DB.prepare("SELECT image_url, image_credit FROM articles_raw WHERE external_id = 'manual-1'").first();
    expect(stored).toEqual(NULLS);
  });
});
