/// <reference types="vite/client" />
/**
 * Migration 0015 (article_events event_id index) against an isolated local D1
 * binding (Miniflare). Never runs against a shared or production database.
 *
 * d1/schema.sql already defines the index, so each test first recreates the
 * pre-0015 state (production's) by dropping only that index, then applies the
 * real migration file. Query plans are checked for the application's own
 * queries, read from workers/src/db/client.ts rather than copied.
 *
 * See pipeline-e2e.test.ts for why `cloudflare:test-internal` is imported.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error -- untyped pool runtime module (see pipeline-e2e.test.ts)
import { env as workerEnv } from 'cloudflare:test-internal';
import schemaSql from '../../d1/schema.sql?raw';
import migration0015 from '../../d1/migrations/0015_article_events_event_id_index.sql?raw';
import clientSource from '../src/db/client.ts?raw';

const DB = (workerEnv as unknown as { DB: D1Database }).DB;
const INDEX = 'idx_article_events_event_id';

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
  for (const stmt of splitSql(sql)) await DB.prepare(stmt).run();
}

/** The current schema without this index: the state of databases created before it existed. */
async function createPre0015Database(): Promise<void> {
  await run(schemaSql);
  await DB.prepare(`DROP INDEX ${INDEX}`).run();
}

async function eventIdIndexes(): Promise<{ name: string; tbl_name: string }[]> {
  return (await DB.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?1")
    .bind(INDEX).all<{ name: string; tbl_name: string }>()).results;
}

/** The SQL template literal that follows `marker` in db/client.ts. */
function clientQuery(marker: string): string {
  const at = clientSource.indexOf(marker);
  if (at < 0) throw new Error(`"${marker}" not found in workers/src/db/client.ts`);
  const start = clientSource.indexOf('`', at);
  const end = clientSource.indexOf('`', start + 1);
  return clientSource.slice(start + 1, end);
}

// The application queries that look up article_events by event_id, with values
// for their parameters (two event ids where the query takes a list), and how
// SQLite reaches article_events without the index:
// - 'scan': `LEFT JOIN article_events ae ON e.id = ae.event_id` scans the whole
//   table once per active event (the pattern behind the 2026-10-14 incident);
// - 'primary-key': the planner starts from articles_raw instead and looks up
//   article_events by its (article_raw_id, event_id) primary key.
const QUERIES: [string, string, unknown[], 'scan' | 'primary-key'][] = [
  ['getRecentActiveEvents (active events by latest article)', clientQuery('async getRecentActiveEvents('), [10], 'scan'],
  ['getActiveEvents statsQuery (event listing stats)', clientQuery('const statsQuery = `'), [], 'scan'],
  ['getArticlesBeforeAckBatch (articles per event before an ack)',
    clientQuery('async getArticlesBeforeAckBatch(').replace('${placeholders}', '?, ?'), [1, 2, 1760000000], 'primary-key'],
];

/** EXPLAIN QUERY PLAN lines that access article_events (aliased `ae` in every query above). */
async function articleEventsPlan(sql: string, params: unknown[]): Promise<string[]> {
  const rows = (await DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params).all<{ detail: string }>()).results;
  return rows.map(r => r.detail).filter(d => /\bae\b/.test(d));
}

describe('Migration 0015: article_events event_id index (local D1)', () => {
  it('creates the index on article_events(event_id) in a pre-0015 database', async () => {
    await createPre0015Database();
    expect(await eventIdIndexes()).toEqual([]);

    await run(migration0015);

    expect(await eventIdIndexes()).toEqual([{ name: INDEX, tbl_name: 'article_events' }]);
    const columns = (await DB.prepare(`PRAGMA index_info(${INDEX})`).all<{ seqno: number; name: string }>()).results;
    expect(columns.map(c => ({ seqno: c.seqno, name: c.name }))).toEqual([{ seqno: 0, name: 'event_id' }]);
  });

  it('is a no-op when run again or on a database built from schema.sql', async () => {
    await createPre0015Database();
    await run(migration0015);
    await run(migration0015);
    expect(await eventIdIndexes()).toHaveLength(1);

    // schema.sql already creates the index; the migration must not fail on it.
    await run(schemaSql);
    await run(migration0015);
    expect(await eventIdIndexes()).toHaveLength(1);
  });

  it.each(QUERIES)('%s uses the index after 0015', async (_name, sql, params, withoutIndex) => {
    expect(sql).toMatch(/\bae\.event_id\b/);
    await createPre0015Database();

    const before = await articleEventsPlan(sql, params);
    expect(before.length).toBeGreaterThan(0);
    expect(before.join('\n')).not.toContain(INDEX);
    if (withoutIndex === 'scan') {
      expect(before.some(d => /^SCAN ae\b/.test(d))).toBe(true);
    } else {
      expect(before.some(d => /^SEARCH ae USING COVERING INDEX sqlite_autoindex_article_events_1 \(article_raw_id=\? AND event_id=\?\)/.test(d))).toBe(true);
    }

    await run(migration0015);

    const after = await articleEventsPlan(sql, params);
    expect(after.some(d => /^SEARCH ae USING (COVERING )?INDEX idx_article_events_event_id \(event_id=\?\)/.test(d))).toBe(true);
    expect(after.some(d => /^SCAN ae\b/.test(d))).toBe(false);
  });
});
