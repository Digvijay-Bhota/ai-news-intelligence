/// <reference types="vite/client" />
/**
 * Article-detail `extracted_entities` (the article page's Key Entities): the
 * processor stores {"topics": string[], "events": [...]} in
 * article_content.extracted_entities, and GET /api/v1/articles/:id returns
 * its topics as labels. Runs against an isolated local D1 and KV (Miniflare).
 *
 * See pipeline-e2e.test.ts for why `cloudflare:test-internal` is imported.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error -- untyped pool runtime module (see pipeline-e2e.test.ts)
import { env as workerEnv } from 'cloudflare:test-internal';
import schemaSql from '../../d1/schema.sql?raw';
import { route } from '../src/router';
import { keyEntityLabels } from '../src/db/client';
import { buildSignedRequest } from '../src/utils/hmac';
import { createMockEnv, TEST_SECRET } from './setup';
import type { Env } from '../src/types';

const bindings = workerEnv as unknown as { DB: D1Database; CACHE: KVNamespace };
const DB = bindings.DB;
const VERGE_IMAGE = 'https://platform.theverge.com/uploads/photo.jpg';

/** extracted_entities exactly as processor.ts stores it. */
const processorEntities = (topics: string[], events: { title: string; description: string; severity: string }[] = []) =>
  JSON.stringify({ topics, events });

const EVENT = { title: 'Chip export rules tightened', description: 'New limits on accelerator exports.', severity: 'high' };

describe('keyEntityLabels', () => {
  it('returns the topics from the stored processor object', () => {
    expect(keyEntityLabels(processorEntities(['OpenAI', 'GPU export rules'], [EVENT]))).toEqual(['OpenAI', 'GPU export rules']);
  });

  it('trims labels and drops empty, duplicate and non-string topics', () => {
    expect(keyEntityLabels(JSON.stringify({ topics: [' OpenAI ', 'OpenAI', '', '  ', 42, null, { name: 'x' }, 'Nvidia'], events: [] })))
      .toEqual(['OpenAI', 'Nvidia']);
  });

  it('still accepts a plain string array', () => {
    expect(keyEntityLabels(JSON.stringify(['OpenAI', 7, 'Nvidia']))).toEqual(['OpenAI', 'Nvidia']);
  });

  it('returns no labels for missing, empty, malformed or unexpected data', () => {
    for (const stored of [
      null, undefined, '', '{', 'not json', 'null', '42', '"OpenAI"', '{}',
      processorEntities([], [EVENT]),
      JSON.stringify({ topics: 'OpenAI' }),
      JSON.stringify({ events: [EVENT] }),
    ]) {
      expect(keyEntityLabels(stored)).toEqual([]);
    }
  });
});

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
async function getArticle(id: number, env: Env): Promise<Record<string, unknown>> {
  const ts = Math.floor(Date.now() / 1000);
  const req = await buildSignedRequest(new Request(`http://localhost/api/v1/articles/${id}`, { method: 'GET' }), TEST_SECRET, `key-entities-${++nonce}`, ts);
  const res = await route(req, env);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

/** Inserts a processed article; `stored` is its article_content.extracted_entities (no row when undefined). */
async function insertArticle(id: number, source: string, imageUrl: string | null, stored?: string | null): Promise<void> {
  await DB.prepare(`INSERT INTO articles_raw (id, external_id, source_id, title, summary, url, raw_content, published_at, status, image_url, image_credit)
    VALUES (?1, ?2, (SELECT id FROM sources WHERE name = ?3), ?4, 'Summary', ?5, '<item/>', 1760000000, 'processed', ?6, ?7)`)
    .bind(id, `ext-${id}`, source, `Story ${id}`, `https://news.example.test/${id}`, imageUrl, imageUrl ? 'Photo Desk' : null).run();
  if (stored !== undefined) {
    await DB.prepare('INSERT INTO article_content (article_raw_id, cleaned_text, extracted_entities) VALUES (?1, ?2, ?3)')
      .bind(id, `Cleaned ${id}`, stored).run();
  }
}

const ARTICLE_DETAIL_KEYS = [
  'cleaned_text', 'events', 'external_id', 'extracted_entities', 'id', 'image_credit', 'image_url',
  'published_at', 'source', 'summary', 'title', 'topics', 'url',
];

describe('GET /api/v1/articles/:id extracted_entities (local D1)', () => {
  let env: Env;

  beforeEach(async () => {
    for (const stmt of splitSql(schemaSql)) await DB.prepare(stmt).run();
    env = createMockEnv({ DB, CACHE: bindings.CACHE });
  });

  it('returns the stored topics without changing the other article-detail fields', async () => {
    await insertArticle(1, 'The Verge', VERGE_IMAGE, processorEntities(['OpenAI', 'GPU export rules', ' OpenAI '], [EVENT]));
    const topic = await DB.prepare("INSERT INTO topics (name, slug) VALUES ('OpenAI', 'openai') RETURNING id").first<{ id: number }>();
    await DB.prepare('INSERT INTO article_topics (article_raw_id, topic_id, confidence) VALUES (1, ?1, 1.0)').bind(topic?.id).run();
    await DB.prepare("INSERT INTO events (id, event_hash, title, description, severity, started_at) VALUES (1, 'evt-1', ?1, ?2, ?3, 1760000000)")
      .bind(EVENT.title, EVENT.description, EVENT.severity).run();
    await DB.prepare('INSERT INTO article_events (article_raw_id, event_id) VALUES (1, 1)').run();

    const article = await getArticle(1, env);

    expect(article.extracted_entities).toEqual(['OpenAI', 'GPU export rules']);
    expect(Object.keys(article).sort()).toEqual(ARTICLE_DETAIL_KEYS);
    expect(article).toMatchObject({
      id: 1, external_id: 'ext-1', title: 'Story 1', summary: 'Summary', cleaned_text: 'Cleaned 1',
      url: 'https://news.example.test/1', source: 'The Verge', published_at: 1760000000,
      topics: [{ name: 'OpenAI', slug: 'openai' }],
      events: [{ event_hash: 'evt-1', title: EVENT.title, description: EVENT.description, severity: EVENT.severity, started_at: 1760000000 }],
      // Approved host for The Verge: image fields still go through re-validation.
      image_url: VERGE_IMAGE, image_credit: 'Photo Desk',
    });
  });

  it('keeps image fields null for a source without an approved image host', async () => {
    await insertArticle(2, 'TechCrunch', VERGE_IMAGE, processorEntities(['Robotics']));
    const article = await getArticle(2, env);
    expect(article.extracted_entities).toEqual(['Robotics']);
    expect(article).toMatchObject({ image_url: null, image_credit: null });
  });

  it('returns no labels for unprocessed, empty or malformed content', async () => {
    await insertArticle(3, 'The Verge', null); // no article_content row yet
    await insertArticle(4, 'The Verge', null, null);
    await insertArticle(5, 'The Verge', null, processorEntities([], [EVENT]));
    await insertArticle(6, 'The Verge', null, '{"topics": ["unterminated"');
    await insertArticle(7, 'The Verge', null, JSON.stringify({ topics: [{ name: 'OpenAI' }] }));

    for (const id of [3, 4, 5, 6, 7]) {
      const article = await getArticle(id, env);
      expect(article.extracted_entities).toEqual([]);
      expect(article).toMatchObject({ id, title: `Story ${id}` });
    }
    expect((await getArticle(3, env)).cleaned_text).toBeNull();
  });
});
