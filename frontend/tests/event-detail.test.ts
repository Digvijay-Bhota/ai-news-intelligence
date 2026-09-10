/**
 * event-detail.test.ts — Phase 9: Event Detail & Grounded Brief BFF Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '../src/app/api/events/[hash]/route';
import { env } from 'cloudflare:workers';
import type { EventDetailResponse, EventBrief } from '../src/types';

vi.mock('../src/lib/session', () => ({
  getOrCreateUserId: vi.fn(() => 'test-user-id')
}));

vi.mock('cloudflare:workers', () => ({
  env: {
    HMAC_SECRET: undefined,
    BACKEND_API: undefined,
  },
}));

describe('BFF /api/events/:hash Route — Phase 9 Intelligence Brief', () => {
  beforeEach(() => {
    (env as any).HMAC_SECRET = 'test-secret-key-32-bytes-long!!';
    (env as any).BACKEND_API = {
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({
          'X-RateLimit-Limit': '100',
          'X-RateLimit-Remaining': '95',
          'X-RateLimit-Reset': '1700000000',
          'Content-Type': 'application/json',
        }),
        json: async () => mockEventDetailResponse,
      }),
    };
  });

  function makeRequest(url = 'http://localhost/api/events/test-hash') {
    const req = new Request(url);
    return Object.assign(req, { nextUrl: new URL(url) }) as unknown as import('next/server').NextRequest;
  }

  const mockBrief: EventBrief = {
    summary: 'A grounded intelligence brief summarizing multi-source reporting on the event.',
    why_it_matters: 'Sets an important technological precedent.',
    key_developments: ['Initial coverage emerged.', 'Secondary confirmation published.'],
    key_entities: [
      { name: 'AlphaCorp', type: 'organization', relevance: 'Primary entity involved.' },
    ],
    uncertainties: ['Regulatory review is ongoing.'],
    source_references: [
      { article_id: 1, claim_context: 'First article reference context.' },
      { article_id: 2, claim_context: 'Second article reference context.' },
    ],
  };

  const mockEventDetailResponse: EventDetailResponse = {
    success: true,
    data: {
      event: {
        hash: 'test-hash',
        title: 'Test Grounded AI Event',
        description: 'Test event description for briefing evaluation',
        severity: 'high',
        started_at: 1700000000,
        last_published_at: 1700010000,
        freshness: 'developing',
      },
      coverage: {
        total_articles: 5,
        total_sources: 3,
        first_published_at: 1700000000,
        last_published_at: 1700010000,
        sources: [
          { name: 'Source A', article_count: 3, first_published_at: 1700000000 },
          { name: 'Source B', article_count: 2, first_published_at: 1700005000 },
        ],
      },
      intelligence: {
        topic_count: 2,
        unique_topics: ['AI', 'Tech'],
        days_active: 1,
        coverage_density: 5,
        top_source: 'Source A',
      },
      brief: mockBrief,
      brief_metadata: {
        version: 1,
        status: 'completed',
        generated_at: 1700010500,
        model: 'gemini-3.6-flash',
        article_fingerprint: 'sha256-fingerprint-abc-123',
        article_count: 5,
        source_count: 3,
        is_stale: false,
        unincorporated_article_count: 0,
      },
      change_summary: {
        has_changed: false,
        article_delta: 0,
        source_delta: 0,
        latest_activity_at: 1700010000,
      },
      articles: [
        {
          id: 1,
          external_id: 'ext-1',
          title: 'Article One',
          summary: 'Summary 1',
          url: 'https://example.com/1',
          source: 'Source A',
          published_at: 1700000000,
          category: null,
          topics: ['AI'],
          events: [{ title: 'Test Event', hash: 'test-hash' }],
        },
        {
          id: 2,
          external_id: 'ext-2',
          title: 'Article Two',
          summary: 'Summary 2',
          url: 'https://example.com/2',
          source: 'Source B',
          published_at: 1700005000,
          category: null,
          topics: ['Tech'],
          events: [{ title: 'Test Event', hash: 'test-hash' }],
        },
      ],
    },
  };

  it('forwards HMAC signed request to backend for event detail', async () => {
    const req = makeRequest();
    const res = await GET(req, { params: Promise.resolve({ hash: 'test-hash' }) });

    expect(res.status).toBe(200);
    const mockFetch = (env as any).BACKEND_API.fetch;
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const sentReq: Request = mockFetch.mock.calls[0][0];
    expect(sentReq.url).toContain('/api/v1/events/test-hash');
    expect(sentReq.headers.get('X-HMAC-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(sentReq.headers.get('X-Nonce')).toBeDefined();
    expect(sentReq.headers.get('X-Timestamp')).toBeDefined();
  });

  it('returns grounded brief data and change detection summary', async () => {
    const req = makeRequest();
    const res = await GET(req, { params: Promise.resolve({ hash: 'test-hash' }) });

    const json = (await res.json()) as EventDetailResponse;
    expect(json.success).toBe(true);
    expect(json.data.brief).toBeDefined();
    expect(json.data.brief?.summary).toBe(mockBrief.summary);
    expect(json.data.brief?.why_it_matters).toBe(mockBrief.why_it_matters);
    expect(json.data.brief?.key_developments).toHaveLength(2);
    expect(json.data.brief?.key_entities).toHaveLength(1);
    expect(json.data.brief?.uncertainties).toHaveLength(1);
    expect(json.data.brief?.source_references).toHaveLength(2);
    expect(json.data.brief_metadata?.status).toBe('completed');
    expect(json.data.brief_metadata?.article_count).toBe(5);
    expect(json.data.change_summary?.has_changed).toBe(false);
  });

  it('handles stale brief detection when article delta is positive', async () => {
    const staleResponse: EventDetailResponse = {
      ...mockEventDetailResponse,
      data: {
        ...mockEventDetailResponse.data,
        coverage: {
          ...mockEventDetailResponse.data.coverage,
          total_articles: 7,
          total_sources: 4,
        },
        brief_metadata: {
          ...mockEventDetailResponse.data.brief_metadata!,
          is_stale: true,
          unincorporated_article_count: 2,
        },
        change_summary: {
          has_changed: true,
          article_delta: 2,
          source_delta: 1,
          latest_activity_at: 1700020000,
        },
      },
    };

    (env as any).BACKEND_API.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => staleResponse,
    });

    const req = makeRequest();
    const res = await GET(req, { params: Promise.resolve({ hash: 'test-hash' }) });

    const json = (await res.json()) as EventDetailResponse;
    expect(json.data.brief_metadata?.is_stale).toBe(true);
    expect(json.data.brief_metadata?.unincorporated_article_count).toBe(2);
    expect(json.data.change_summary?.has_changed).toBe(true);
    expect(json.data.change_summary?.article_delta).toBe(2);
    expect(json.data.change_summary?.source_delta).toBe(1);
  });

  it('handles unavailable brief gracefully (null brief, unavailable status)', async () => {
    const unavailableResponse: EventDetailResponse = {
      ...mockEventDetailResponse,
      data: {
        ...mockEventDetailResponse.data,
        brief: null,
        brief_metadata: null,
        change_summary: null,
      },
    };

    (env as any).BACKEND_API.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => unavailableResponse,
    });

    const req = makeRequest();
    const res = await GET(req, { params: Promise.resolve({ hash: 'test-hash' }) });

    const json = (await res.json()) as EventDetailResponse;
    expect(json.data.brief).toBeNull();
    expect(json.data.brief_metadata).toBeNull();
    expect(json.data.change_summary).toBeNull();
    expect(json.data.event.title).toBe('Test Grounded AI Event');
  });

  it('propagates backend 404 when event is not found', async () => {
    (env as any).BACKEND_API.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      text: async () => '{"error":"Event not found"}',
    });

    const req = makeRequest('http://localhost/api/events/nonexistent');
    const res = await GET(req, { params: Promise.resolve({ hash: 'nonexistent' }) });

    expect(res.status).toBe(404);
  });

  it('returns 500 when HMAC_SECRET is not configured', async () => {
    (env as any).HMAC_SECRET = undefined;

    const req = makeRequest();
    const res = await GET(req, { params: Promise.resolve({ hash: 'test-hash' }) });

    expect(res.status).toBe(500);
    const json = await res.json() as any;
    expect(json.error).toBe('Missing HMAC_SECRET');
  });

  it('returns narrative_delta and claim_comparisons for Version 2 event', async () => {
    const v2Response: EventDetailResponse = {
      ...mockEventDetailResponse,
      data: {
        ...mockEventDetailResponse.data,
        brief_metadata: {
          ...mockEventDetailResponse.data.brief_metadata!,
          version: 2,
        },
        narrative_delta: {
          previous_version: 1,
          current_version: 2,
          summary: 'Reporting evolved with confirmed resignation and regulatory filings.',
          newly_confirmed: [
            { statement: 'CEO resignation was officially filed.', source_references: [1] },
          ],
          changed_claims: [
            {
              previous_statement: 'Acquisition price estimated at $1B',
              current_statement: 'Deal confirmed at $1.4B in filings',
              change_type: 'refined',
              source_references: [1],
            },
          ],
          removed_or_no_longer_supported: [],
          unchanged_core: ['Company remains under antitrust scrutiny.'],
          open_questions: ['Successor appointment timeline.'],
        },
        narrative_delta_metadata: {
          previous_version: 1,
          current_version: 2,
          status: 'completed',
          model: 'gemini-3.6-flash',
          generated_at: 1700020000,
          article_fingerprint: 'sha256-v2',
        },
        claim_comparisons: [
          {
            claim: 'Deal valuation',
            status: 'consensus',
            sources: [
              {
                source_id: 1,
                source_name: 'Source A',
                position: 'Reports $1.4B confirmed valuation.',
                article_ids: [1],
              },
            ],
          },
        ],
        claim_comparison_metadata: {
          version: 2,
          status: 'completed',
          model: 'gemini-3.6-flash',
          generated_at: 1700020000,
          claim_count: 1,
          article_fingerprint: 'sha256-v2',
        },
      },
    };

    (env as any).BACKEND_API.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => v2Response,
    });

    const req = makeRequest();
    const res = await GET(req, { params: Promise.resolve({ hash: 'test-hash' }) });

    const json = (await res.json()) as EventDetailResponse;
    expect(json.data.narrative_delta).toBeDefined();
    expect(json.data.narrative_delta?.previous_version).toBe(1);
    expect(json.data.narrative_delta?.current_version).toBe(2);
    expect(json.data.narrative_delta?.newly_confirmed).toHaveLength(1);
    expect(json.data.narrative_delta?.changed_claims).toHaveLength(1);
    expect(json.data.claim_comparisons).toHaveLength(1);
    expect(json.data.claim_comparisons![0].status).toBe('consensus');
  });
});
