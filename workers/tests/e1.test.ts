import { describe, it, expect } from 'vitest';
import { route } from '../src/router';
import { createMockEnv, createMockD1Database, createMockKVNamespace, TEST_SECRET } from './setup';
import { buildSignedRequest } from '../src/utils/hmac';
import type { ApiResponse } from '../src/types';

describe('E1 Article Detail', () => {
  function makeEnv() {
    const db = createMockD1Database(true);
    const env = createMockEnv({ DB: db, CACHE: createMockKVNamespace() });
    return env;
  }

  async function signedRequest(url: string, method: string): Promise<Request> {
    const req = new Request(url, { method });
    const ts = Math.floor(Date.now() / 1000);
    return buildSignedRequest(req, TEST_SECRET, `nonce-${ts}`, ts);
  }

  it('GET /api/v1/articles/:id returns 404 for nonexistent', async () => {
    const env = makeEnv();
    const req = await signedRequest('http://localhost/api/v1/articles/999', 'GET');
    const res = await route(req, env);
    expect(res.status).toBe(404);
  });

  it('GET /api/v1/articles/:id returns detail for existing article', async () => {
    const env = makeEnv();
    // Due to seed=true, getArticleById(1) returns the seeded article.
    const req = await signedRequest('http://localhost/api/v1/articles/1', 'GET');
    const res = await route(req, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as ApiResponse<any>;
    expect(json.success).toBe(true);
    expect(json.data.id).toBe(1);
    expect(json.data.source).toBe('unknown'); // Mock db getSourceById returns empty for unseeded source
  });
});
