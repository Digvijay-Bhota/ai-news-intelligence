/// <reference types="vite/client" />
/**
 * Community-signal review workflow against a real local D1 binding (Miniflare):
 * the internal candidate-list endpoint, the review endpoint, and the operator CLI
 * client (scripts/signal-review/client.mjs) talking to the real router.
 *
 * See pipeline-e2e.test.ts for why `cloudflare:test-internal` is imported.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
// @ts-expect-error -- untyped pool runtime module (see pipeline-e2e.test.ts)
import { env as workerEnv } from 'cloudflare:test-internal';
import schemaSql from '../../d1/schema.sql?raw';
import { route } from '../src/router';
import { buildSignedRequest, generateHmac, sha256Hex, verifyHmac } from '../src/utils/hmac';
import { createMockEnv, TEST_SECRET } from './setup';
import type { Env } from '../src/types';
import {
  approveSignal,
  formatCandidates,
  listCandidates,
  parseConfig,
  rejectSignal,
  ReviewApiError,
  signPayload,
  UsageError,
  type ReviewConfig,
} from '../scripts/signal-review/client.mjs';

const REVIEWER = 'reviewer@example.test';
// Each reviewer token's name is the reviewer identity it may sign reviews as.
const ADMIN = { id: 'tok-review-admin', secret: 'review-admin-secret', scopes: 'internal,admin', name: REVIEWER };
const SECOND = { id: 'tok-review-admin-2', secret: 'review-admin-2-secret', scopes: 'internal,admin', name: 'second-reviewer@example.test' };
const LOW = { id: 'tok-review-low', secret: 'review-low-secret', scopes: 'internal', name: 'low-scope@example.test' };
const LIST_A = 'http://localhost/internal/v1/events/evt-a/community/signals/candidates';

const bindings = workerEnv as unknown as { DB: D1Database; CACHE: KVNamespace };
const DB = bindings.DB;
let env: Env;
let nonce = 0;

function splitSchema(sql: string): string[] {
  return sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n')
    .split(';').map((s) => s.trim()).filter((s) => s.length > 0 && !/^PRAGMA\b/i.test(s));
}

const config: ReviewConfig = {
  apiUrl: 'http://localhost', hmacSecret: TEST_SECRET, tokenId: ADMIN.id, tokenSecret: ADMIN.secret, reviewerId: REVIEWER,
};
/** The CLI client's transport: hand its signed Request straight to the Worker router. */
const viaRouter = (req: Request) => route(req, env);

async function signed(url: string, opts: { method?: string; token?: { id: string; secret?: string }; body?: unknown; userId?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) {
    headers['X-Token-ID'] = opts.token.id;
    if (opts.token.secret !== undefined) headers['X-Token-Secret'] = opts.token.secret;
  }
  if (opts.userId) headers['X-Authenticated-User-Id'] = opts.userId;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const req = new Request(url, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  return buildSignedRequest(req, TEST_SECRET, `review-nonce-${++nonce}`, Math.floor(Date.now() / 1000));
}

function errorFrom(fn: () => unknown): Error | undefined {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  return undefined;
}

async function signalStatus(id: string) {
  return (await DB.prepare('SELECT status FROM community_signals WHERE id = ?').bind(id).first<{ status: string }>())?.status;
}
async function reviews() {
  return (await DB.prepare('SELECT signal_id, reviewer_id, previous_status, new_status, reason FROM community_signal_reviews').all<any>()).results;
}

beforeEach(async () => {
  for (const stmt of splitSchema(schemaSql)) await DB.prepare(stmt).run();
  for (const t of [ADMIN, SECOND, LOW]) {
    await DB.prepare('INSERT INTO pipeline_tokens (token_id, token_secret_hash, name, scopes) VALUES (?1, ?2, ?3, ?4)')
      .bind(t.id, await sha256Hex(t.secret), t.name, t.scopes).run();
  }
  const evA = (await DB.prepare("INSERT INTO events (event_hash, title, severity, status) VALUES ('evt-a', 'A', 'low', 'active') RETURNING id").first<{ id: number }>())!.id;
  const evB = (await DB.prepare("INSERT INTO events (event_hash, title, severity, status) VALUES ('evt-b', 'B', 'low', 'active') RETURNING id").first<{ id: number }>())!.id;
  for (const u of ['user-1', 'user-2', 'user-3', 'user-4']) await DB.prepare('INSERT INTO users (id) VALUES (?)').bind(u).run();

  const post = (id: string, ev: number, user: string, status: string, created: number, body = `Body of ${id}`) =>
    DB.prepare('INSERT INTO community_posts (id, event_id, user_id, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, ev, user, body, status, created).run();
  await post('post-a1', evA, 'user-1', 'active', 100);
  await post('post-a2', evA, 'user-2', 'active', 101);
  await post('post-a3', evA, 'user-3', 'active', 102, 'x'.repeat(600));
  await post('post-a4-hidden', evA, 'user-4', 'hidden', 103);
  await post('post-b1', evB, 'user-4', 'active', 104);

  const signal = (id: string, ev: number, status: string, created: number) =>
    DB.prepare("INSERT INTO community_signals (id, event_id, type, status, content, created_at, updated_at) VALUES (?, ?, 'emerging_theme', ?, ?, ?, ?)")
      .bind(id, ev, status, `Content of ${id}`, created, created).run();
  await signal('sig-a-candidate', evA, 'candidate', 200);
  await signal('sig-a-weak', evA, 'candidate', 201);
  await signal('sig-a-approved', evA, 'approved', 202);
  await signal('sig-b-candidate', evB, 'candidate', 203);

  const evidence = (sig: string, postId: string) =>
    DB.prepare('INSERT INTO community_signal_evidence (signal_id, post_id) VALUES (?, ?)').bind(sig, postId).run();
  // Strong candidate: 3 active posts on A, plus a hidden post and a post from event B that must not count.
  for (const p of ['post-a1', 'post-a2', 'post-a3', 'post-a4-hidden', 'post-b1']) await evidence('sig-a-candidate', p);
  await evidence('sig-a-weak', 'post-a1');
  await evidence('sig-a-approved', 'post-a1');
  await evidence('sig-b-candidate', 'post-b1');

  env = createMockEnv({ DB, CACHE: bindings.CACHE });
});

describe('GET /internal/v1/events/:hash/community/signals/candidates — authorization', () => {
  it('rejects an unsigned request with 401', async () => {
    expect((await route(new Request(LIST_A), env)).status).toBe(401);
  });

  it('rejects a signed request without a token, without a token secret, or with a wrong secret (401)', async () => {
    expect((await route(await signed(LIST_A), env)).status).toBe(401);
    expect((await route(await signed(LIST_A, { token: { id: ADMIN.id } }), env)).status).toBe(401);
    expect((await route(await signed(LIST_A, { token: { id: ADMIN.id, secret: 'wrong' } }), env)).status).toBe(401);
  });

  it('rejects a valid token that lacks the admin scope with 403', async () => {
    expect((await route(await signed(LIST_A, { token: LOW }), env)).status).toBe(403);
  });

  it('accepts a token with internal + admin scopes and its matching secret', async () => {
    const res = await route(await signed(LIST_A, { token: ADMIN }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('Candidate listing contents', () => {
  it('lists only candidate signals of the requested event, oldest first', async () => {
    const data = await listCandidates(config, 'evt-a', {}, viaRouter);
    expect(data.candidates.map((c) => c.id)).toEqual(['sig-a-candidate', 'sig-a-weak']);
    expect(data).toMatchObject({ has_more: false, limit: 20 });
  });

  it('counts and shows only active evidence posts that belong to the event', async () => {
    const [strong, weak] = (await listCandidates(config, 'evt-a', {}, viaRouter)).candidates;
    expect(strong).toMatchObject({ active_evidence_count: 3, distinct_author_count: 3, meets_public_threshold: true });
    expect(strong.evidence.map((e) => e.post_id)).toEqual(['post-a1', 'post-a2', 'post-a3']);
    const long = strong.evidence[2];
    expect(long.body).toHaveLength(500);
    expect(long.body_truncated).toBe(true);
    expect(weak).toMatchObject({ active_evidence_count: 1, distinct_author_count: 1, meets_public_threshold: false });
  });

  it('never exposes user IDs, user hashes, reviewer identities or token data', async () => {
    const res = await route(await signed(LIST_A, { token: ADMIN, userId: REVIEWER }), env);
    const text = await res.text();
    for (const secretish of ['user-1', 'user-2', 'user-3', 'user-4', ADMIN.id, ADMIN.secret, REVIEWER]) {
      expect(text).not.toContain(secretish);
    }
    for (const key of ['user_id', 'user_hash', 'reviewer_id', 'token', 'event_id']) {
      expect(text).not.toContain(`"${key}"`);
    }
  });

  it('bounds results: validates limit and reports has_more', async () => {
    const page = await listCandidates(config, 'evt-a', { limit: 1 }, viaRouter);
    expect(page.candidates.map((c) => c.id)).toEqual(['sig-a-candidate']);
    expect(page.has_more).toBe(true);
    for (const bad of ['0', '51', 'abc', '1.5']) {
      const res = await route(await signed(`${LIST_A}?limit=${bad}`, { token: ADMIN }), env);
      expect(res.status).toBe(400);
    }
  });

  it('caps evidence excerpts at 10 per candidate while reporting the full count', async () => {
    const ev = (await DB.prepare("SELECT id FROM events WHERE event_hash = 'evt-a'").first<{ id: number }>())!.id;
    for (let i = 0; i < 12; i++) {
      await DB.prepare("INSERT INTO community_posts (id, event_id, user_id, body, status, created_at) VALUES (?, ?, 'user-1', 'b', 'active', ?)").bind(`bulk-${i}`, ev, 300 + i).run();
      await DB.prepare("INSERT INTO community_signal_evidence (signal_id, post_id) VALUES ('sig-a-weak', ?)").bind(`bulk-${i}`).run();
    }
    const weak = (await listCandidates(config, 'evt-a', {}, viaRouter)).candidates[1];
    expect(weak.active_evidence_count).toBe(13);
    expect(weak.evidence).toHaveLength(10);
    expect(formatCandidates({ candidates: [weak], has_more: false, limit: 20 })).toContain('3 more evidence post(s) not shown');
  });

  it('returns 404 for an unknown event', async () => {
    await expect(listCandidates(config, 'evt-missing', {}, viaRouter)).rejects.toMatchObject({ status: 404 });
  });
});

describe('Operator CLI client', () => {
  it('produces signatures identical to the Worker and verifiable by it', async () => {
    const payload = { method: 'POST', path: '/internal/v1/x?limit=2', timestamp: 1700000000, nonce: 'n-1', body: '{"a":1}', userId: REVIEWER };
    const workerSig = await generateHmac(payload, TEST_SECRET);
    expect(await signPayload(payload, TEST_SECRET)).toBe(workerSig);
    expect(await verifyHmac(payload, await signPayload(payload, TEST_SECRET), TEST_SECRET)).toBe(true);
    const noUser = { ...payload, userId: undefined };
    expect(await signPayload(noUser, TEST_SECRET)).toBe(await generateHmac(noUser, TEST_SECRET));
  });

  it('approves a candidate through the review endpoint, recording the token-bound reviewer', async () => {
    await approveSignal(config, 'evt-a', 'sig-a-candidate', viaRouter);
    expect(await signalStatus('sig-a-candidate')).toBe('approved');
    expect(await reviews()).toEqual([{ signal_id: 'sig-a-candidate', reviewer_id: REVIEWER, previous_status: 'candidate', new_status: 'approved', reason: null }]);
  });

  it('rejects a candidate with a reason', async () => {
    await rejectSignal(config, 'evt-a', 'sig-a-weak', '  Not enough independent evidence  ', viaRouter);
    expect(await signalStatus('sig-a-weak')).toBe('rejected');
    expect(await reviews()).toEqual([expect.objectContaining({ signal_id: 'sig-a-weak', new_status: 'rejected', reason: 'Not enough independent evidence' })]);
  });

  it('refuses to reject without a reason, client-side and server-side', async () => {
    const transport = vi.fn(viaRouter);
    expect(() => rejectSignal(config, 'evt-a', 'sig-a-weak', '   ', transport)).toThrow(UsageError);
    expect(transport).not.toHaveBeenCalled();

    const res = await route(await signed('http://localhost/internal/v1/events/evt-a/community/signals/sig-a-weak/review',
      { method: 'POST', token: ADMIN, userId: REVIEWER, body: { status: 'rejected' } }), env);
    expect(res.status).toBe(400);
    expect(await signalStatus('sig-a-weak')).toBe('candidate');
    expect(await reviews()).toEqual([]);
  });

  it('reports invalid transitions and unknown or cross-event signals as clear API errors', async () => {
    const err = await approveSignal(config, 'evt-a', 'sig-a-approved', viaRouter).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReviewApiError);
    expect(err).toMatchObject({ status: 409, message: 'Forbidden transition from approved to approved' });
    await expect(approveSignal(config, 'evt-a', 'sig-missing', viaRouter)).rejects.toMatchObject({ status: 404 });
    await expect(approveSignal(config, 'evt-a', 'sig-b-candidate', viaRouter)).rejects.toMatchObject({ status: 404 });
    expect(await signalStatus('sig-b-candidate')).toBe('candidate');

    const badStatus = await route(await signed('http://localhost/internal/v1/events/evt-a/community/signals/sig-a-weak/review',
      { method: 'POST', token: ADMIN, userId: REVIEWER, body: { status: 'candidate' } }), env);
    expect(badStatus.status).toBe(400);
    expect(await reviews()).toEqual([]);
  });

  it('review still requires the signed reviewer identity and the admin scope', async () => {
    const url = 'http://localhost/internal/v1/events/evt-a/community/signals/sig-a-candidate/review';
    const noUser = await route(await signed(url, { method: 'POST', token: ADMIN, body: { status: 'approved' } }), env);
    expect(noUser.status).toBe(401);
    const lowScope = await route(await signed(url, { method: 'POST', token: LOW, userId: REVIEWER, body: { status: 'approved' } }), env);
    expect(lowScope.status).toBe(403);
    expect(await signalStatus('sig-a-candidate')).toBe('candidate');
  });

  it('rejects a signed reviewer identity that differs from the token name (403), writing nothing', async () => {
    // Valid HMAC, nonce/timestamp, token ID + secret and internal + admin scopes; only the identity differs.
    const impostor = { ...config, reviewerId: 'impostor@example.test' };
    for (const attempt of [
      approveSignal(impostor, 'evt-a', 'sig-a-candidate', viaRouter),
      rejectSignal(impostor, 'evt-a', 'sig-a-weak', 'Looks wrong', viaRouter),
    ]) {
      await expect(attempt).rejects.toMatchObject({ status: 403, message: 'Reviewer identity does not match the authenticated token' });
    }
    expect(await signalStatus('sig-a-candidate')).toBe('candidate');
    expect(await signalStatus('sig-a-weak')).toBe('candidate');
    expect(await reviews()).toEqual([]);

    // Listing only needs the internal + admin scopes.
    await expect(listCandidates(impostor, 'evt-a', {}, viaRouter)).resolves.toMatchObject({ has_more: false });
  });

  it('prevents one reviewer token from signing reviews as another reviewer', async () => {
    const second = { ...config, tokenId: SECOND.id, tokenSecret: SECOND.secret };
    await expect(approveSignal({ ...second, reviewerId: REVIEWER }, 'evt-a', 'sig-a-candidate', viaRouter))
      .rejects.toMatchObject({ status: 403 });
    expect(await signalStatus('sig-a-candidate')).toBe('candidate');
    expect(await reviews()).toEqual([]);

    await approveSignal({ ...second, reviewerId: SECOND.name }, 'evt-a', 'sig-a-candidate', viaRouter);
    expect(await reviews()).toEqual([expect.objectContaining({ signal_id: 'sig-a-candidate', reviewer_id: SECOND.name, new_status: 'approved' })]);
  });

  it('validates configuration without echoing secret values', () => {
    const base = {
      SIGNAL_REVIEW_API_URL: 'https://api.example.test', HMAC_SECRET: 'h-secret', SIGNAL_REVIEW_TOKEN_ID: 'tid',
      SIGNAL_REVIEW_TOKEN_SECRET: 't-secret', SIGNAL_REVIEW_REVIEWER_ID: 'ops@example.test',
    };
    expect(parseConfig(base)).toMatchObject({ apiUrl: 'https://api.example.test', reviewerId: 'ops@example.test' });
    expect(() => parseConfig({ ...base, SIGNAL_REVIEW_API_URL: 'http://api.example.test' })).toThrow(UsageError);
    expect(() => parseConfig({ ...base, SIGNAL_REVIEW_API_URL: 'https://api.example.test/prefix' })).toThrow(UsageError);
    expect(() => parseConfig({ ...base, SIGNAL_REVIEW_REVIEWER_ID: 'ops\u001b[31m' })).toThrow(UsageError);
    expect(parseConfig({ ...base, SIGNAL_REVIEW_API_URL: 'http://localhost:8787' }).apiUrl).toBe('http://localhost:8787');
    const missing = errorFrom(() => parseConfig({ ...base, HMAC_SECRET: undefined }));
    expect(missing).toBeInstanceOf(UsageError);
    expect(missing!.message).toContain('HMAC_SECRET');
    const padded = errorFrom(() => parseConfig({ ...base, SIGNAL_REVIEW_TOKEN_SECRET: ' t-secret ' }));
    expect(padded).toBeInstanceOf(UsageError);
    expect(padded!.message).not.toContain('t-secret');
  });

  it('sanitizes user-generated text in the human-readable listing', () => {
    const out = formatCandidates({
      has_more: false, limit: 20,
      candidates: [{
        id: 's1', type: 'emerging_theme', content: 'Theme\u001b[2J', created_at: 0,
        active_evidence_count: 1, distinct_author_count: 1, meets_public_threshold: false,
        evidence: [{ post_id: 'p1', body: 'evil\u001b]0;title\u0007body', body_truncated: false, created_at: 0 }],
      }],
    });
    // Only the newlines separating lines remain; escape sequences from post text are neutralised.
    expect(out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(out).toContain('below the 3 posts / 3 authors');
  });
});
