import { describe, it, expect } from 'vitest';
import { route } from '../src/router';
import { createMockEnv, createMockD1Database, createMockKVNamespace, TEST_SECRET } from './setup';
import { buildSignedRequest } from '../src/utils/hmac';
import type { ApiResponse } from '../src/types';

describe('Integration', () => {
  function makeEnv() {
    return createMockEnv({ DB: createMockD1Database(), CACHE: createMockKVNamespace() });
  }

  async function signedRequest(url: string, method: string, body?: object, isInternal = false): Promise<Request> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (isInternal) headers['X-Token-ID'] = 'test-token';
    const req = new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const ts = Math.floor(Date.now() / 1000);
    return buildSignedRequest(req, TEST_SECRET, `nonce-${ts}`, ts);
  }

  it('full public API flow', async () => {
    const env = makeEnv();

    // Health check
    const healthReq = await signedRequest('http://localhost/api/v1/health', 'GET');
    const healthRes = await route(healthReq, env);
    expect(healthRes.status).toBe(200);

    // Get feed
    const feedReq = await signedRequest('http://localhost/api/v1/feed', 'GET');
    const feedRes = await route(feedReq, env);
    expect(feedRes.status).toBe(200);

    // Set preferences
    const prefsReq = await signedRequest('http://localhost/api/v1/preferences', 'POST', {
      user_id: 'integration-user',
      preferred_topics: ['artificial-intelligence'],
      digest_frequency: 'daily',
    });
    const prefsRes = await route(prefsReq, env);
    expect(prefsRes.status).toBe(200);

    // Get preferences
    const getPrefsReq = await signedRequest('http://localhost/api/v1/preferences?user_id=integration-user', 'GET');
    const getPrefsRes = await route(getPrefsReq, env);
    expect(getPrefsRes.status).toBe(200);
    const prefsJson = (await getPrefsRes.json()) as ApiResponse<any>;
    expect(prefsJson.data.user_id).toBe('integration-user');

    // Save article
    const saveReq = await signedRequest('http://localhost/api/v1/saved', 'POST', {
      user_id: 'integration-user',
      article_raw_id: 1,
      note: 'Important',
    });
    const saveRes = await route(saveReq, env);
    expect(saveRes.status).toBe(201);

    // List saved
    const listReq = await signedRequest('http://localhost/api/v1/saved?user_id=integration-user', 'GET');
    const listRes = await route(listReq, env);
    expect(listRes.status).toBe(200);

    // Hide story
    const hideReq = await signedRequest('http://localhost/api/v1/hide', 'POST', {
      user_id: 'integration-user',
      article_raw_id: 2,
    });
    const hideRes = await route(hideReq, env);
    expect(hideRes.status).toBe(201);
  });

  it('CORS headers present on responses', async () => {
    const env = makeEnv();
    const req = await signedRequest('http://localhost/api/v1/health', 'GET');
    const res = await route(req, env);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeTruthy();
    expect(res.headers.get('Access-Control-Allow-Methods')).toBeTruthy();
  });

  it('rate limit headers present', async () => {
    const env = makeEnv();
    const req = await signedRequest('http://localhost/api/v1/health', 'GET');
    const res = await route(req, env);
    expect(res.headers.get('X-RateLimit-Limit')).toBeTruthy();
    expect(res.headers.get('X-RateLimit-Remaining')).toBeTruthy();
  });

  it('rejects unauthenticated request', async () => {
    const env = makeEnv();
    const req = new Request('http://localhost/api/v1/feed', { method: 'GET' });
    const res = await route(req, env);
    expect(res.status).toBe(401);
  });

  it('rejects request with bad HMAC', async () => {
    const env = makeEnv();
    const req = new Request('http://localhost/api/v1/feed', {
      method: 'GET',
      headers: {
        'X-HMAC-Signature': 'bad-sig',
        'X-Nonce': 'nonce',
        'X-Timestamp': String(Math.floor(Date.now() / 1000)),
      },
    });
    const res = await route(req, env);
    expect(res.status).toBe(401);
  });
});
