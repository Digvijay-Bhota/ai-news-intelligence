import { describe, it, expect } from 'vitest';
import { route } from '../src/router';
import { createMockEnv, createMockD1Database, createMockKVNamespace, TEST_SECRET } from './setup';
import { buildSignedRequest } from '../src/utils/hmac';
import type { ApiResponse, PersonalizedFeedResult } from '../src/types';

describe('GET /api/v1/feed/for-you (Phase 11B)', () => {
  const baseD1 = createMockD1Database(true);
  const baseKV = createMockKVNamespace();

  function makeEnv() {
    return createMockEnv({
      DB: baseD1,
      CACHE: baseKV,
      HMAC_SECRET: TEST_SECRET,
    });
  }

  async function signedRequest(
    url: string,
    method = 'GET',
    body?: Record<string, unknown>,
    isInternal = false,
    explicitUserId?: string
  ): Promise<Request> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (isInternal) headers['X-Token-ID'] = 'test-token';
    if (explicitUserId) headers['X-Authenticated-User-Id'] = explicitUserId;

    const req = new Request(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const ts = Math.floor(Date.now() / 1000);
    const nonce = `nonce-${ts}-${Math.random().toString(36).substring(2, 9)}`;
    return buildSignedRequest(req, TEST_SECRET, nonce, ts);
  }

  describe('Authentication & Authorization', () => {
    it('requires authenticated user context (fails without X-Authenticated-User-Id or user_id)', async () => {
      const env = makeEnv();
      const req = await signedRequest('http://localhost/api/v1/feed/for-you', 'GET');
      const res = await route(req, env);
      expect(res.status).toBe(401);
    });

    it('rejects client user_id mismatch against authenticated user identity', async () => {
      const env = makeEnv();
      const req = await signedRequest(
        'http://localhost/api/v1/feed/for-you?user_id=spoofed-user',
        'GET',
        undefined,
        false,
        'actual-user'
      );
      const res = await route(req, env);
      expect(res.status).toBe(403);
    });

    it('succeeds with valid authenticated user identity', async () => {
      const env = makeEnv();
      const req = await signedRequest(
        'http://localhost/api/v1/feed/for-you',
        'GET',
        undefined,
        false,
        'user-cold-start'
      );
      const res = await route(req, env);
      expect(res.status).toBe(200);
      const json = (await res.json()) as ApiResponse<PersonalizedFeedResult>;
      expect(json.success).toBe(true);
      expect(json.data!.items).toBeDefined();
    });

    it('enforces private, no-store Cache-Control header', async () => {
      const env = makeEnv();
      const req = await signedRequest(
        'http://localhost/api/v1/feed/for-you',
        'GET',
        undefined,
        false,
        'user-cold-start'
      );
      const res = await route(req, env);
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('private, no-cache, no-store, must-revalidate');
    });
  });

  describe('Cold Start (Zero Follows)', () => {
    it('returns canonical intelligence events when user has 0 follows', async () => {
      const env = makeEnv();
      const req = await signedRequest(
        'http://localhost/api/v1/feed/for-you',
        'GET',
        undefined,
        false,
        'new-user-no-follows'
      );
      const res = await route(req, env);
      expect(res.status).toBe(200);
      const json = (await res.json()) as ApiResponse<PersonalizedFeedResult>;

      expect(json.success).toBe(true);
      expect(json.data!.meta.user_has_follows).toBe(false);
      expect(json.data!.meta.fallback_applied).toBe(false);
      expect(json.data!.items.length).toBeGreaterThan(0);

      // Event 1 has narrative delta, claim comparison, warning, developing
      const first = json.data!.items[0];
      expect(first.hash).toBe('evt-hash');
      expect(first.brief_version).toBe(2);
      expect(first.has_narrative_delta).toBe(true);
      expect(first.has_claim_comparison).toBe(true);
      expect(first.rank_reasons).toContain('Narrative Evolved (V2)');
      expect(first.rank_reasons).toContain('Cross-Source Perspectives');
    });
  });

  describe('Follow Influence & Explainability', () => {
    it('promotes event when user follows the event directly (+120)', async () => {
      const env = makeEnv();
      const userId = 'user-event-follower';

      // Follow event directly
      const followReq = await signedRequest(
        'http://localhost/api/v1/follows',
        'POST',
        { target_type: 'event', target_id: 'evt-hash' },
        false,
        userId
      );
      const followRes = await route(followReq, env);
      expect(followRes.status).toBe(201);

      // Fetch personalized feed
      const feedReq = await signedRequest(
        'http://localhost/api/v1/feed/for-you',
        'GET',
        undefined,
        false,
        userId
      );
      const feedRes = await route(feedReq, env);
      expect(feedRes.status).toBe(200);
      const json = (await feedRes.json()) as ApiResponse<PersonalizedFeedResult>;

      expect(json.data!.meta.user_has_follows).toBe(true);
      expect(json.data!.meta.fallback_applied).toBe(false);

      const topItem = json.data!.items[0];
      expect(topItem.hash).toBe('evt-hash');
      expect(topItem.rank_reasons).toContain('Following Event');
      // Score includes +120
      expect(topItem.score).toBeGreaterThan(120);
    });

    it('promotes event when user follows topic', async () => {
      const env = makeEnv();
      const userId = 'user-topic-follower';

      // Follow topic
      const followReq = await signedRequest(
        'http://localhost/api/v1/follows',
        'POST',
        { target_type: 'topic', target_id: 'machine-learning' },
        false,
        userId
      );
      const followRes = await route(followReq, env);
      expect(followRes.status).toBe(201);

      const feedReq = await signedRequest(
        'http://localhost/api/v1/feed/for-you',
        'GET',
        undefined,
        false,
        userId
      );
      const feedRes = await route(feedReq, env);
      expect(feedRes.status).toBe(200);
      const json = (await feedRes.json()) as ApiResponse<PersonalizedFeedResult>;

      const mlEvent = json.data!.items.find(i => i.hash === 'evt-hash-2');
      expect(mlEvent).toBeDefined();
      expect(mlEvent!.rank_reasons).toContain('Topic: machine-learning');
    });

    it('sets fallback_applied = true when user has follows but none match candidate events', async () => {
      const env = makeEnv();
      const userId = 'user-unmatched-follower';

      // Follow a topic that candidates don't have
      await baseD1
        .prepare('INSERT INTO user_follows (user_id, target_type, target_id, created_at) VALUES (?1, ?2, ?3, ?4)')
        .bind(userId, 'topic', 'unmatched-quantum-slug', 1000)
        .run();

      const feedReq = await signedRequest(
        'http://localhost/api/v1/feed/for-you',
        'GET',
        undefined,
        false,
        userId
      );
      const feedRes = await route(feedReq, env);
      expect(feedRes.status).toBe(200);
      const json = (await feedRes.json()) as ApiResponse<PersonalizedFeedResult>;

      expect(json.data!.meta.user_has_follows).toBe(true);
      expect(json.data!.meta.fallback_applied).toBe(true);
      expect(json.data!.items.length).toBeGreaterThan(0);
    });
  });

  describe('User Isolation', () => {
    it('guarantees User A follows do not influence User B', async () => {
      const env = makeEnv();
      const userA = 'user-isolation-a';
      const userB = 'user-isolation-b';

      // User A follows evt-hash
      await baseD1
        .prepare('INSERT INTO user_follows (user_id, target_type, target_id, created_at) VALUES (?1, ?2, ?3, ?4)')
        .bind(userA, 'event', 'evt-hash', 1000)
        .run();

      // User B has no follows
      const resA = await route(
        await signedRequest('http://localhost/api/v1/feed/for-you', 'GET', undefined, false, userA),
        env
      );
      const resB = await route(
        await signedRequest('http://localhost/api/v1/feed/for-you', 'GET', undefined, false, userB),
        env
      );

      const jsonA = ((await resA.json()) as ApiResponse<PersonalizedFeedResult>).data!;
      const jsonB = ((await resB.json()) as ApiResponse<PersonalizedFeedResult>).data!;

      expect(jsonA.meta.user_has_follows).toBe(true);
      expect(jsonA.items[0].rank_reasons).toContain('Following Event');

      expect(jsonB.meta.user_has_follows).toBe(false);
      expect(jsonB.items[0].rank_reasons).not.toContain('Following Event');
      expect(jsonB.items[0].score).toBeLessThan(jsonA.items[0].score);
    });
  });

  describe('Pagination & Validation', () => {
    it('applies default limit 20 and offset 0', async () => {
      const env = makeEnv();
      const req = await signedRequest(
        'http://localhost/api/v1/feed/for-you',
        'GET',
        undefined,
        false,
        'user-page'
      );
      const res = await route(req, env);
      const json = (await res.json()) as ApiResponse<PersonalizedFeedResult>;
      expect(json.data!.meta.limit).toBe(20);
      expect(json.data!.meta.offset).toBe(0);
    });

    it('rejects non-integer limit', async () => {
      const env = makeEnv();
      const req = await signedRequest(
        'http://localhost/api/v1/feed/for-you?limit=abc',
        'GET',
        undefined,
        false,
        'user-page'
      );
      const res = await route(req, env);
      expect(res.status).toBe(400);
    });

    it('rejects limit out of range (<1 or >50)', async () => {
      const env = makeEnv();
      const reqZero = await signedRequest(
        'http://localhost/api/v1/feed/for-you?limit=0',
        'GET',
        undefined,
        false,
        'user-page'
      );
      const resZero = await route(reqZero, env);
      expect(resZero.status).toBe(400);

      const reqTooBig = await signedRequest(
        'http://localhost/api/v1/feed/for-you?limit=51',
        'GET',
        undefined,
        false,
        'user-page'
      );
      const resTooBig = await route(reqTooBig, env);
      expect(resTooBig.status).toBe(400);
    });

    it('rejects negative or malformed offset', async () => {
      const env = makeEnv();
      const req = await signedRequest(
        'http://localhost/api/v1/feed/for-you?offset=-5',
        'GET',
        undefined,
        false,
        'user-page'
      );
      const res = await route(req, env);
      expect(res.status).toBe(400);
    });

    it('supports valid limit and offset pagination', async () => {
      const env = makeEnv();
      const req = await signedRequest(
        'http://localhost/api/v1/feed/for-you?limit=1&offset=1',
        'GET',
        undefined,
        false,
        'user-page'
      );
      const res = await route(req, env);
      expect(res.status).toBe(200);
      const json = (await res.json()) as ApiResponse<PersonalizedFeedResult>;
      expect(json.data!.items.length).toBe(1);
      expect(json.data!.meta.limit).toBe(1);
      expect(json.data!.meta.offset).toBe(1);
    });
  });
});
