/// <reference types="vite/client" />
/**
 * Migration 0014 (article image metadata) against an isolated local D1
 * binding (Miniflare). Never runs against a shared or production database.
 *
 * See pipeline-e2e.test.ts for why `cloudflare:test-internal` is imported.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error -- untyped pool runtime module (see pipeline-e2e.test.ts)
import { env as workerEnv } from 'cloudflare:test-internal';
import schemaSql from '../../d1/schema.sql?raw';
import migration0014 from '../../d1/migrations/0014_article_image_metadata.sql?raw';

const DB = (workerEnv as unknown as { DB: D1Database }).DB;

/** sources and articles_raw exactly as in d1/schema.sql before migration 0014 (commit 5de3da9). */
const PRE_0014_DDL = `
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  feed_url TEXT,
  base_url TEXT NOT NULL,
  source_type TEXT DEFAULT 'rss',
  reliability_score REAL DEFAULT 0.5,
  fetch_interval_minutes INTEGER DEFAULT 60,
  active INTEGER DEFAULT 1,
  last_fetched_at INTEGER,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS articles_raw (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT UNIQUE NOT NULL,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  title TEXT NOT NULL,
  summary TEXT,
  url TEXT NOT NULL,
  raw_content TEXT,
  published_at INTEGER,
  fetched_at INTEGER DEFAULT (unixepoch()),
  language TEXT DEFAULT 'en',
  status TEXT DEFAULT 'pending',
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);`;

interface ColumnInfo { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }

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

async function columns(): Promise<ColumnInfo[]> {
  const rows = (await DB.prepare('PRAGMA table_info(articles_raw)').all<ColumnInfo>()).results;
  return rows.map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }));
}

async function seedLegacyArticle(): Promise<Record<string, unknown>> {
  await DB.prepare("INSERT INTO sources (name, feed_url, base_url) VALUES ('The Verge', 'https://www.theverge.com/rss/index.xml', 'https://theverge.com')").run();
  await DB.prepare(`INSERT INTO articles_raw (external_id, source_id, title, summary, url, raw_content, published_at, status)
    VALUES ('legacy-1', 1, 'Legacy story', 'Summary', 'https://www.theverge.com/legacy', '<item>raw</item>', 1760000000, 'processed')`).run();
  return (await DB.prepare("SELECT * FROM articles_raw WHERE external_id = 'legacy-1'").first<Record<string, unknown>>())!;
}

describe('Migration 0014: article image metadata (local D1)', () => {
  it('adds nullable TEXT image columns with no defaults to a pre-0014 table', async () => {
    await run(PRE_0014_DDL);
    expect((await columns()).map(c => c.name)).not.toContain('image_url');

    await run(migration0014);

    const added = (await columns()).filter(c => c.name === 'image_url' || c.name === 'image_credit');
    expect(added).toEqual([
      { name: 'image_url', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { name: 'image_credit', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    ]);
  });

  it('leaves legacy rows unchanged and returns null image fields for them', async () => {
    await run(PRE_0014_DDL);
    const before = await seedLegacyArticle();

    await run(migration0014);

    const after = await DB.prepare("SELECT * FROM articles_raw WHERE external_id = 'legacy-1'").first<Record<string, unknown>>();
    expect(after).toEqual({ ...before, image_url: null, image_credit: null });
  });

  it('accepts new rows with and without image metadata after migrating', async () => {
    await run(PRE_0014_DDL);
    await seedLegacyArticle();
    await run(migration0014);

    await DB.prepare(`INSERT INTO articles_raw (external_id, source_id, title, url, image_url, image_credit)
      VALUES ('new-1', 1, 'With image', 'https://www.theverge.com/a', 'https://platform.theverge.com/a.jpg', 'Desk')`).run();
    await DB.prepare("INSERT INTO articles_raw (external_id, source_id, title, url) VALUES ('new-2', 1, 'Without image', 'https://www.theverge.com/b')").run();

    const rows = (await DB.prepare('SELECT external_id, image_url, image_credit FROM articles_raw ORDER BY id').all()).results;
    expect(rows).toEqual([
      { external_id: 'legacy-1', image_url: null, image_credit: null },
      { external_id: 'new-1', image_url: 'https://platform.theverge.com/a.jpg', image_credit: 'Desk' },
      { external_id: 'new-2', image_url: null, image_credit: null },
    ]);
  });

  it('produces the same articles_raw columns as a fresh schema.sql database', async () => {
    await run(PRE_0014_DDL);
    await run(migration0014);
    const migrated = await columns();

    await DB.prepare('DROP TABLE articles_raw').run();
    await DB.prepare('DROP TABLE sources').run();
    await run(schemaSql);

    expect(await columns()).toEqual(migrated);
  });

  it('is not repeatable: a second application fails loudly and changes nothing', async () => {
    await run(PRE_0014_DDL);
    await seedLegacyArticle();
    await run(migration0014);
    // Compare rows only: the full D1 result also carries timing metadata (meta.duration).
    const before = (await DB.prepare('SELECT * FROM articles_raw').all()).results;
    expect(before).toHaveLength(1);

    await expect(run(migration0014)).rejects.toThrow(/duplicate column name/i);
    expect((await DB.prepare('SELECT * FROM articles_raw').all()).results).toEqual(before);
  });

  it('must not be applied on top of the current schema.sql (columns already exist)', async () => {
    await run(schemaSql);
    await expect(run(migration0014)).rejects.toThrow(/duplicate column name/i);
  });
});
