/// <reference types="vite/client" />
/**
 * Article image metadata during RSS ingestion, against an isolated local D1
 * binding (Miniflare). Feeds and Gemini are stubbed; any other outbound fetch
 * (including any image URL) fails the test.
 *
 * See pipeline-e2e.test.ts for why `cloudflare:test-internal` is imported.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
// @ts-expect-error -- untyped pool runtime module (see pipeline-e2e.test.ts)
import { env as workerEnv } from 'cloudflare:test-internal';
import schemaSql from '../../d1/schema.sql?raw';
import { fetchAndIngest, parseRss } from '../src/tasks/fetcher';
import { runPipeline } from '../src/tasks/orchestrator';
import { generateArticleHash } from '../src/tasks/normalization';
import { MAX_ARTICLE_RAW_CONTENT_LENGTH } from '../src/utils/image-extraction';
import { createMockEnv } from './setup';
import type { Source } from '../src/types';

const bindings = workerEnv as unknown as { DB: D1Database; CACHE: KVNamespace };
const DB = bindings.DB;
const VERGE_FEED_URL = 'https://www.theverge.com/rss/index.xml';
const TECHCRUNCH_FEED_URL = 'https://techcrunch.com/feed/';
const GEMINI_HOST = 'generativelanguage.googleapis.com';
const VERGE_IMAGE = 'https://platform.theverge.com/uploads/2026/10/photo.jpg';

const item = (guid: string, title: string, extra = '', description = 'Story text.') => `
  <item>
    <title>${title}</title>
    <link>https://news.example.test/${guid}</link>
    <guid>${guid}</guid>
    <description>${description}</description>
    <pubDate>Mon, 05 Oct 2026 10:00:00 GMT</pubDate>
    ${extra}
  </item>`;
const rss = (items: string) =>
  `<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Feed</title>${items}</channel></rss>`;

const VERGE_FEED = rss([
  item('v-image', 'Verge story with approved image',
    `<media:content url="${VERGE_IMAGE}?w=1200&amp;q=85" medium="image" width="1200" height="675"><media:credit>Verge Photo Desk</media:credit></media:content>`),
  item('v-plain', 'Verge story without an image'),
  item('v-subdomain', 'Verge story on an unapproved subdomain',
    '<media:content url="https://cdn.platform.theverge.com/a.jpg" medium="image"/>'),
  item('v-borrowed-credit', 'Verge story whose credit belongs to another image',
    `<media:content url="${VERGE_IMAGE}" medium="image" width="1600" height="900"/>
     <media:content url="https://platform.theverge.com/small.jpg" medium="image" width="400" height="225"><media:credit>Small Agency</media:credit></media:content>`),
  item('v-oversized', 'Verge story too large to parse',
    `<enclosure url="${VERGE_IMAGE}" type="image/jpeg"/>`, 'x'.repeat(MAX_ARTICLE_RAW_CONTENT_LENGTH)),
  item('v-malformed', 'Verge story with malformed markup',
    `<enclosure url="${VERGE_IMAGE}" type="image/jpeg"/>`, '<![CDATA[ unterminated'),
].join(''));

const TECHCRUNCH_FEED = rss(item('t-verge-host', 'TechCrunch story using a Verge-approved host',
  `<media:content url="${VERGE_IMAGE}" medium="image" width="1200" height="675"><media:credit>Desk</media:credit></media:content>`));

const EXPECTED: Record<string, { image_url: string | null; image_credit: string | null }> = {
  'v-image': { image_url: `${VERGE_IMAGE}?w=1200&q=85`, image_credit: 'Verge Photo Desk' },
  'v-plain': { image_url: null, image_credit: null },
  'v-subdomain': { image_url: null, image_credit: null },
  'v-borrowed-credit': { image_url: VERGE_IMAGE, image_credit: null },
  'v-oversized': { image_url: null, image_credit: null },
  'v-malformed': { image_url: null, image_credit: null },
  't-verge-host': { image_url: null, image_credit: null },
};

/** Removes every image-bearing element so a run can be compared with and without images. */
const withoutImages = (feed: string) =>
  feed.replace(/<media:content[\s\S]*?(?:\/>|<\/media:content>)|<enclosure[^>]*\/>/g, '');

interface Log { gemini: number; enrichment: number; prompts: string[]; other: string[] }

function installFetchStub(feeds: { verge: string; techcrunch: string }): Log {
  const log: Log = { gemini: 0, enrichment: 0, prompts: [], other: [] };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === VERGE_FEED_URL) return new Response(feeds.verge, { status: 200 });
    if (url === TECHCRUNCH_FEED_URL) return new Response(feeds.techcrunch, { status: 200 });
    if (new URL(url).host === GEMINI_HOST) {
      log.gemini++;
      const body = String(init?.body ?? '');
      log.prompts.push(body);
      const prompt: string = JSON.parse(body || '{}').contents?.[0]?.parts?.[0]?.text ?? '';
      if (prompt.startsWith('Analyze this article')) {
        log.enrichment++;
        const payload = { summary: 'Summary.', topics: ['Media'], events: [{ title: 'Image test event', description: 'd', severity: 'medium' }] };
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] });
      }
      if (prompt.includes('semantic event matching engine')) {
        const id = Number(prompt.match(/ID: (\d+) \| Title: Image test event/)?.[1]);
        const payload = Number.isInteger(id) ? { match: true, event_id: id } : { match: false, event_id: null };
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] });
      }
      return new Response('stubbed', { status: 400, statusText: 'Stubbed' });
    }
    log.other.push(url);
    throw new Error(`Unexpected outbound fetch in test: ${url}`);
  }));
  return log;
}

function splitSql(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^PRAGMA\b/i.test(s));
}

async function setupSchema(): Promise<Record<string, Source>> {
  for (const stmt of splitSql(schemaSql)) await DB.prepare(stmt).run();
  const rows = (await DB.prepare('SELECT * FROM sources').all<Source>()).results;
  return Object.fromEntries(rows.map(r => [r.name, r]));
}

async function storedImages(): Promise<Record<string, { image_url: string | null; image_credit: string | null }>> {
  const rows = (await DB.prepare('SELECT external_id, image_url, image_credit FROM articles_raw').all<{ external_id: string; image_url: string | null; image_credit: string | null }>()).results;
  return Object.fromEntries(rows.map(({ external_id, ...fields }) => [external_id, fields]));
}

describe('Article image metadata during RSS ingestion (local D1)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stores only an approved The Verge image and a structurally tied credit', async () => {
    const sources = await setupSchema();
    installFetchStub({ verge: VERGE_FEED, techcrunch: TECHCRUNCH_FEED });
    const env = createMockEnv({ DB, CACHE: bindings.CACHE });

    expect(await fetchAndIngest(env, sources['The Verge'])).toBe(6);
    expect(await fetchAndIngest(env, sources['TechCrunch'])).toBe(1);

    expect(await storedImages()).toEqual(EXPECTED);
  });

  it('keeps article fields, dedup hashes and dedup behavior unchanged', async () => {
    const sources = await setupSchema();
    installFetchStub({ verge: VERGE_FEED, techcrunch: TECHCRUNCH_FEED });
    const env = createMockEnv({ DB, CACHE: bindings.CACHE });
    await fetchAndIngest(env, sources['The Verge']);

    const parsed = parseRss(VERGE_FEED);
    const rows = (await DB.prepare('SELECT * FROM articles_raw ORDER BY id').all<any>()).results;
    expect(rows.map(r => ({ external_id: r.external_id, title: r.title, url: r.url, summary: r.summary, raw_content: r.raw_content, published_at: r.published_at })))
      .toEqual(parsed.map(p => ({ external_id: p.external_id, title: p.title, url: p.url, summary: p.summary, raw_content: p.raw_content, published_at: p.published_at })));

    for (const p of parsed) {
      const hash = await generateArticleHash(p.title, p.url);
      expect(await DB.prepare('SELECT 1 AS ok FROM dedup_hashes WHERE hash = ?1').bind(hash).first()).toEqual({ ok: 1 });
    }
    expect(await fetchAndIngest(env, sources['The Verge'])).toBe(0);
  });

  it('runs the pipeline with healthy sources, no extra model calls and no image fields in prompts', async () => {
    await setupSchema();
    const env = createMockEnv({ DB, CACHE: bindings.CACHE });

    const log = installFetchStub({ verge: VERGE_FEED, techcrunch: TECHCRUNCH_FEED });
    await runPipeline(env);

    expect(await storedImages()).toEqual(EXPECTED);
    expect(log.other).toEqual([]); // nothing fetched besides feeds and Gemini: no image requests
    expect(log.enrichment).toBe(Object.keys(EXPECTED).length);
    for (const body of log.prompts) {
      expect(body).not.toMatch(/image_url|image_credit/);
    }

    const health = (await DB.prepare(`SELECT s.name, h.status FROM source_health h JOIN sources s ON s.id = h.source_id
      WHERE s.name IN ('The Verge', 'TechCrunch') ORDER BY s.name`).all()).results;
    expect(health).toEqual([{ name: 'TechCrunch', status: 'healthy' }, { name: 'The Verge', status: 'healthy' }]);
    expect(await DB.prepare("SELECT COUNT(*) AS n FROM articles_raw WHERE status = 'processed'").first()).toEqual({ n: 7 });
  });

  it('makes exactly the same model calls with or without image metadata in the feeds', async () => {
    await setupSchema();
    const env = createMockEnv({ DB, CACHE: bindings.CACHE });

    const withImages = installFetchStub({ verge: VERGE_FEED, techcrunch: TECHCRUNCH_FEED });
    await runPipeline(env);

    // Reset article state so the second run starts from the same point.
    for (const table of ['article_events', 'article_topics', 'article_content', 'ai_logs', 'ai_jobs', 'dedup_hashes', 'events', 'articles_raw']) {
      await DB.prepare(`DELETE FROM ${table}`).run();
    }
    vi.unstubAllGlobals();
    const imageFree = installFetchStub({ verge: withoutImages(VERGE_FEED), techcrunch: withoutImages(TECHCRUNCH_FEED) });
    await runPipeline(env);

    expect(Object.values(await storedImages()).every(f => f.image_url === null && f.image_credit === null)).toBe(true);
    expect(imageFree.enrichment).toBe(withImages.enrichment);
    expect(imageFree.gemini).toBe(withImages.gemini);
  });
});
