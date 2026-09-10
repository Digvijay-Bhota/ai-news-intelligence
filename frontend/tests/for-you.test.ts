/**
 * for-you.test.ts — Phase 11B: Personalized Intelligence Feed BFF Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '../src/app/api/feed/for-you/route';
import { env } from 'cloudflare:workers';
import type { PersonalizedFeedResponse, PersonalizedFeedItem } from '../src/types';

vi.mock('../src/lib/session', () => ({
  getOrCreateUserId: vi.fn(() => 'test-user-id'),
}));

vi.mock('cloudflare:workers', () => ({
  env: {
    HMAC_SECRET: undefined,
    BACKEND_API: undefined,
  },
}));

describe('BFF /api/feed/for-you Route — Phase 11B Personalized Feed', () => {
  const mockPersonalizedEvent: PersonalizedFeedItem = {
    id: 1,
    hash: 'evt-hash-1',
    title: 'Breakthrough in AI Reasoning Models',
    description: 'Researchers introduce new continuous test-time compute paradigm.',
    severity: 'warning',
    freshness: 'developing',
    article_count: 8,
    source_count: 4,
    started_at: 1700000000,
    last_published_at: 1700003600,
    topics: ['artificial-intelligence', 'machine-learning'],
    sources: ['TechCrunch', 'Reuters'],
    brief_version: 2,
    has_narrative_delta: true,
    has_claim_comparison: true,
    score: 245,
    rank_reasons: [
      'Following Event',
      'Topic: artificial-intelligence',
      'Narrative Evolved (V2)',
      'Developing Story',
      'Broad Multi-Source Coverage',
    ],
  };

  const mockFeedResponse: PersonalizedFeedResponse = {
    success: true,
    data: {
      items: [mockPersonalizedEvent],
      meta: {
        total: 1,
        limit: 20,
        offset: 0,
        user_has_follows: true,
        fallback_applied: false,
      },
    },
  };

  beforeEach(() => {
    (env as any).HMAC_SECRET = 'test-secret-key-32-bytes-long!!';
    (env as any).BACKEND_API = {
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({
          'X-RateLimit-Limit': '100',
          'X-RateLimit-Remaining': '99',
          'X-RateLimit-Reset': '1700000000',
          'Content-Type': 'application/json',
        }),
        json: async () => mockFeedResponse,
      }),
    };
  });

  function makeRequest(url = 'http://localhost/api/feed/for-you') {
    const req = new Request(url);
    return Object.assign(req, { nextUrl: new URL(url) }) as unknown as import('next/server').NextRequest;
  }

  it('returns 500 when HMAC_SECRET is missing', async () => {
    (env as any).HMAC_SECRET = undefined;
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('Missing HMAC_SECRET');
  });

  it('returns 500 when BACKEND_API binding is missing', async () => {
    (env as any).BACKEND_API = undefined;
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('Missing BACKEND_API binding');
  });

  it('successfully returns personalized feed and passes private cache headers', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache, no-store, must-revalidate');

    const json = (await res.json()) as PersonalizedFeedResponse;
    expect(json.success).toBe(true);
    expect(json.data.items).toHaveLength(1);

    const event = json.data.items[0];
    expect(event.hash).toBe('evt-hash-1');
    expect(event.score).toBe(245);
    expect(event.rank_reasons).toContain('Following Event');
    expect(event.rank_reasons).toContain('Narrative Evolved (V2)');
    expect(json.data.meta.user_has_follows).toBe(true);
    expect(json.data.meta.fallback_applied).toBe(false);
  });

  it('signs user identity and attaches X-Authenticated-User-Id to backend request', async () => {
    await GET(makeRequest());
    const mockFetch = (env as any).BACKEND_API.fetch;
    expect(mockFetch).toHaveBeenCalledOnce();

    const sentReq: Request = mockFetch.mock.calls[0][0];
    expect(sentReq.headers.get('X-Authenticated-User-Id')).toBe('test-user-id');
    expect(sentReq.headers.get('X-HMAC-Signature')).toBeDefined();
    expect(sentReq.headers.get('X-Nonce')).toBeDefined();
    expect(sentReq.headers.get('X-Timestamp')).toBeDefined();
  });

  it('correctly forwards pagination query parameters (limit and offset)', async () => {
    await GET(makeRequest('http://localhost/api/feed/for-you?limit=10&offset=20'));
    const mockFetch = (env as any).BACKEND_API.fetch;
    const sentReq: Request = mockFetch.mock.calls[0][0];
    expect(sentReq.url).toContain('/api/v1/feed/for-you?limit=10&offset=20');
  });

  it('propagates backend errors with rate limit headers preserved', async () => {
    (env as any).BACKEND_API.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers({
        'X-RateLimit-Limit': '100',
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': '1700000060',
      }),
      text: async () => 'User ID mismatch forbidden',
    });

    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string; details: string };
    expect(json.error).toContain('Backend error: 403');
    expect(json.details).toBe('User ID mismatch forbidden');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
  });
});
