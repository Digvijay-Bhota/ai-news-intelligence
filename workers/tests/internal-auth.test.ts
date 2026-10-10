/// <reference types="vite/client" />
/**
 * Internal route authorization against a real local D1 binding (Miniflare).
 *
 * Internal requests need: valid HMAC, X-Token-ID of an active unexpired token,
 * X-Token-Secret whose SHA-256 (lowercase hex) matches token_secret_hash,
 * a fresh timestamp/nonce, and the route's scopes.
 *
 * See pipeline-e2e.test.ts for why `cloudflare:test-internal` is imported.
 */
import { describe, it, expect, beforeAll } from 'vitest';
// @ts-expect-error -- untyped pool runtime module (see pipeline-e2e.test.ts)
import { env as workerEnv } from 'cloudflare:test-internal';
import schemaSql from '../../d1/schema.sql?raw';
import { route } from '../src/router';
import { buildSignedRequest, sha256Hex } from '../src/utils/hmac';
import { createMockEnv, TEST_SECRET } from './setup';
import type { Env } from '../src/types';

const ENDPOINT = 'http://localhost/internal/v1/pipeline-log'; // requires scopes internal + admin
const BODY = { job_type: 'auth-test', status: 'completed' };

const TOKENS = {
  valid: { id: 'tok-valid', secret: 'valid-secret-value', scopes: 'internal,admin', active: 1, expires_at: null as number | null },
  inactive: { id: 'tok-inactive', secret: 'inactive-secret-value', scopes: 'internal,admin', active: 0, expires_at: null },
  expired: { id: 'tok-expired', secret: 'expired-secret-value', scopes: 'internal,admin', active: 1, expires_at: 1000 },
  lowScope: { id: 'tok-low-scope', secret: 'low-scope-secret-value', scopes: 'internal', active: 1, expires_at: null },
};

function splitSchema(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^PRAGMA\b/i.test(s));
}

let nonceCounter = 0;

async function internalRequest(opts: {
  tokenId?: string;
  tokenSecret?: string;
  nonce?: string;
  timestamp?: number;
  hmacSecret?: string;
}): Promise<Request> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.tokenId !== undefined) headers['X-Token-ID'] = opts.tokenId;
  if (opts.tokenSecret !== undefined) headers['X-Token-Secret'] = opts.tokenSecret;
  const req = new Request(ENDPOINT, { method: 'POST', headers, body: JSON.stringify(BODY) });
  const ts = opts.timestamp ?? Math.floor(Date.now() / 1000);
  return buildSignedRequest(req, opts.hmacSecret ?? TEST_SECRET, opts.nonce ?? `auth-nonce-${++nonceCounter}`, ts);
}

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}

describe('Internal authorization (local D1)', () => {
  const bindings = workerEnv as unknown as { DB: D1Database; CACHE: KVNamespace };
  let env: Env;

  beforeAll(async () => {
    for (const stmt of splitSchema(schemaSql)) {
      await bindings.DB.prepare(stmt).run();
    }
    for (const t of Object.values(TOKENS)) {
      await bindings.DB
        .prepare('INSERT INTO pipeline_tokens (token_id, token_secret_hash, name, scopes, active, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
        .bind(t.id, await sha256Hex(t.secret), t.id, t.scopes, t.active, t.expires_at)
        .run();
    }
    env = createMockEnv({ DB: bindings.DB, CACHE: bindings.CACHE });
  });

  it('stores the documented hash format (lowercase hex SHA-256)', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('accepts a valid token ID and secret with sufficient scopes', async () => {
    const res = await route(await internalRequest({ tokenId: TOKENS.valid.id, tokenSecret: TOKENS.valid.secret }), env);
    expect(res.status).toBe(201);
    const row = await bindings.DB.prepare("SELECT * FROM pipeline_jobs WHERE job_type = 'auth-test'").first<any>();
    expect(row?.status).toBe('completed');
  });

  it('rejects a missing token secret with 401', async () => {
    const res = await route(await internalRequest({ tokenId: TOKENS.valid.id }), env);
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toBe('Missing X-Token-Secret header');
  });

  it('rejects an empty token secret with 401', async () => {
    const res = await route(await internalRequest({ tokenId: TOKENS.valid.id, tokenSecret: '' }), env);
    expect(res.status).toBe(401);
  });

  it('rejects an incorrect token secret with 401, indistinguishable from an unknown token', async () => {
    const wrong = await route(await internalRequest({ tokenId: TOKENS.valid.id, tokenSecret: 'wrong-secret' }), env);
    expect(wrong.status).toBe(401);
    const unknown = await route(await internalRequest({ tokenId: 'tok-unknown', tokenSecret: 'whatever' }), env);
    expect(unknown.status).toBe(401);
    expect(await errorOf(wrong)).toBe(await errorOf(unknown));
  });

  it('rejects another token\'s secret with 401', async () => {
    const res = await route(await internalRequest({ tokenId: TOKENS.valid.id, tokenSecret: TOKENS.lowScope.secret }), env);
    expect(res.status).toBe(401);
  });

  it('rejects the raw hash supplied as the secret with 401', async () => {
    const hash = await sha256Hex(TOKENS.valid.secret);
    const res = await route(await internalRequest({ tokenId: TOKENS.valid.id, tokenSecret: hash }), env);
    expect(res.status).toBe(401);
  });

  it('rejects a missing token ID with 401', async () => {
    const res = await route(await internalRequest({ tokenSecret: TOKENS.valid.secret }), env);
    expect(res.status).toBe(401);
  });

  it('rejects an inactive token with 401 even with the correct secret', async () => {
    const res = await route(await internalRequest({ tokenId: TOKENS.inactive.id, tokenSecret: TOKENS.inactive.secret }), env);
    expect(res.status).toBe(401);
  });

  it('rejects an expired token with 401 even with the correct secret', async () => {
    const res = await route(await internalRequest({ tokenId: TOKENS.expired.id, tokenSecret: TOKENS.expired.secret }), env);
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toBe('Pipeline token expired');
  });

  it('still requires a valid HMAC signature', async () => {
    const res = await route(
      await internalRequest({ tokenId: TOKENS.valid.id, tokenSecret: TOKENS.valid.secret, hmacSecret: 'not-the-hmac-secret-000000000000' }),
      env
    );
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toBe('Invalid HMAC signature');
  });

  it('still rejects a timestamp outside the replay window', async () => {
    const res = await route(
      await internalRequest({ tokenId: TOKENS.valid.id, tokenSecret: TOKENS.valid.secret, timestamp: Math.floor(Date.now() / 1000) - 3600 }),
      env
    );
    expect(res.status).toBe(401);
  });

  it('still rejects a reused nonce', async () => {
    const creds = { tokenId: TOKENS.valid.id, tokenSecret: TOKENS.valid.secret, nonce: 'auth-reused-nonce' };
    expect((await route(await internalRequest(creds), env)).status).toBe(201);
    const replay = await route(await internalRequest(creds), env);
    expect(replay.status).toBe(401);
    expect(await errorOf(replay)).toBe('Nonce already used');
  });

  it('returns 403 for a valid token lacking required scopes', async () => {
    const res = await route(await internalRequest({ tokenId: TOKENS.lowScope.id, tokenSecret: TOKENS.lowScope.secret }), env);
    expect(res.status).toBe(403);
  });

  it('leaves public HMAC authentication unchanged (no token headers needed)', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const ok = await buildSignedRequest(new Request('http://localhost/api/v1/feed', { method: 'GET' }), TEST_SECRET, `pub-${ts}-a`, ts);
    expect((await route(ok, env)).status).toBe(200);

    const bad = await buildSignedRequest(new Request('http://localhost/api/v1/feed', { method: 'GET' }), 'not-the-hmac-secret-000000000000', `pub-${ts}-b`, ts);
    expect((await route(bad, env)).status).toBe(401);
  });
});
