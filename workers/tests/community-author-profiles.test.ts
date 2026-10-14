/// <reference types="vite/client" />
/**
 * Community listings include posts and replies whose author has no
 * user_profiles row (profiles are created lazily, so posting does not
 * guarantee one). Such authors appear as "Anonymous reader" with a null
 * author_public_id; nothing is derived from, or exposes, user_id.
 * Runs against an isolated local D1 (Miniflare).
 *
 * See pipeline-e2e.test.ts for why `cloudflare:test-internal` is imported.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error -- untyped pool runtime module (see pipeline-e2e.test.ts)
import { env as workerEnv } from 'cloudflare:test-internal';
import schemaSql from '../../d1/schema.sql?raw';
import { route } from '../src/router';
import { createMockEnv } from './setup';
import type { Env } from '../src/types';

const bindings = workerEnv as unknown as { DB: D1Database; CACHE: KVNamespace };
const DB = bindings.DB;
const EVENT_HASH = 'author-profile-event';
const WITH_PROFILE = 'user-id-with-profile-0001';
const WITHOUT_PROFILE = 'user-id-without-profile-0002';
const PROFILE = { public_id: 'pubWithProfile0000001', display_name: 'Reader_A1B2' };
const ANONYMOUS = { author_public_id: null, author_display_name: 'Anonymous reader' };
const PROFILED = { author_public_id: PROFILE.public_id, author_display_name: PROFILE.display_name };

// id, author, parent, status, created_at
const POSTS: [string, string, string | null, string, number][] = [
  ['post-profiled', WITH_PROFILE, null, 'active', 1760000100],
  ['post-anonymous', WITHOUT_PROFILE, null, 'active', 1760000200],
  ['post-flagged-anonymous', WITHOUT_PROFILE, null, 'flagged', 1760000150],
  ['post-hidden', WITHOUT_PROFILE, null, 'hidden', 1760000300],
  ['post-deleted', WITH_PROFILE, null, 'deleted', 1760000400],
  ['reply-anonymous', WITHOUT_PROFILE, 'post-profiled', 'active', 1760000110],
  ['reply-profiled', WITH_PROFILE, 'post-profiled', 'active', 1760000120],
  ['reply-deleted', WITHOUT_PROFILE, 'post-profiled', 'deleted', 1760000130],
  ['reply-hidden', WITH_PROFILE, 'post-profiled', 'hidden', 1760000140],
];

function splitSql(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^PRAGMA\b/i.test(s));
}

/** GET a public Community listing; returns the parsed data and the raw body. */
async function get(path: string, env: Env): Promise<{ data: any; raw: string }> {
  const res = await route(new Request(`http://localhost${path}`, { method: 'GET' }), env);
  expect(res.status).toBe(200);
  const raw = await res.text();
  return { data: (JSON.parse(raw) as { data: any }).data, raw };
}

const authorOf = (item: any) => ({ author_public_id: item.author_public_id, author_display_name: item.author_display_name });

describe('Community listings for authors without a profile (local D1)', () => {
  let env: Env;

  beforeEach(async () => {
    for (const stmt of splitSql(schemaSql)) await DB.prepare(stmt).run();
    for (const id of [WITH_PROFILE, WITHOUT_PROFILE]) {
      await DB.prepare('INSERT INTO users (id) VALUES (?1)').bind(id).run();
    }
    await DB.prepare('INSERT INTO user_profiles (user_id, public_id, display_name) VALUES (?1, ?2, ?3)')
      .bind(WITH_PROFILE, PROFILE.public_id, PROFILE.display_name).run();
    await DB.prepare("INSERT INTO events (id, event_hash, title, severity, started_at) VALUES (1, ?1, 'Author profile event', 'medium', 1760000000)")
      .bind(EVENT_HASH).run();
    for (const [id, userId, parentId, status, createdAt] of POSTS) {
      await DB.prepare(`INSERT INTO community_posts (id, event_id, user_id, parent_id, body, status, created_at, updated_at)
        VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, ?6)`)
        .bind(id, userId, parentId, `Body of ${id}`, status, createdAt).run();
    }
    env = createMockEnv({ DB, CACHE: bindings.CACHE });
  });

  it('lists top-level posts from authors with and without a profile, newest first', async () => {
    const { data } = await get(`/api/v1/events/${EVENT_HASH}/community`, env);

    // Hidden and deleted posts stay excluded; flagged ones stay included.
    expect(data.items.map((p: any) => p.id)).toEqual(['post-anonymous', 'post-flagged-anonymous', 'post-profiled']);
    expect(data.next_cursor).toBeNull();

    const byId = Object.fromEntries(data.items.map((p: any) => [p.id, p]));
    expect(authorOf(byId['post-profiled'])).toEqual(PROFILED);
    expect(authorOf(byId['post-anonymous'])).toEqual(ANONYMOUS);
    expect(authorOf(byId['post-flagged-anonymous'])).toEqual(ANONYMOUS);
  });

  it('counts replies from authors without a profile', async () => {
    const { data } = await get(`/api/v1/events/${EVENT_HASH}/community`, env);
    const counts = Object.fromEntries(data.items.map((p: any) => [p.id, p.reply_count]));

    // post-profiled: reply-anonymous + reply-profiled; deleted and hidden replies are not counted.
    expect(counts).toEqual({ 'post-anonymous': 0, 'post-flagged-anonymous': 0, 'post-profiled': 2 });
  });

  it('lists replies from authors with and without a profile, oldest first', async () => {
    const { data } = await get('/api/v1/community/posts/post-profiled/replies', env);

    expect(data.items.map((r: any) => r.id)).toEqual(['reply-anonymous', 'reply-profiled']);
    expect(authorOf(data.items[0])).toEqual(ANONYMOUS);
    expect(authorOf(data.items[1])).toEqual(PROFILED);
  });

  it('never exposes user_id in post or reply listings', async () => {
    const posts = await get(`/api/v1/events/${EVENT_HASH}/community`, env);
    const replies = await get('/api/v1/community/posts/post-profiled/replies', env);

    for (const { data, raw } of [posts, replies]) {
      for (const item of data.items) expect(item).not.toHaveProperty('user_id');
      expect(raw).not.toContain(WITH_PROFILE);
      expect(raw).not.toContain(WITHOUT_PROFILE);
    }
  });
});
