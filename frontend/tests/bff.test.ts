import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { NextRequest } from 'next/server';
import { generateHmac } from '../src/utils/hmac';
import { GET } from '../src/app/api/feed/route';
import { POST as POST_SAVED } from '../src/app/api/saved/route';
import { DELETE as DELETE_SAVED } from '../src/app/api/saved/[id]/route';
import { POST as POST_HIDE } from '../src/app/api/hide/route';
import { GET as GET_FOLLOWS, POST as POST_FOLLOWS, DELETE as DELETE_FOLLOWS } from '../src/app/api/follows/route';
import { GET as GET_FOR_YOU } from '../src/app/api/feed/for-you/route';
import { env } from 'cloudflare:workers';

vi.mock('../src/lib/session', () => ({
  getOrCreateUserId: vi.fn(() => 'test-user-id')
}));

vi.mock('cloudflare:workers', () => ({
  env: {
    HMAC_SECRET: undefined,
    BACKEND_API: undefined,
  },
}));

/** The env from the vi.mock factory above: tests set, replace and unset its bindings. */
type MockedEnv = {
  HMAC_SECRET: string | undefined;
  BACKEND_API: { fetch: Mock } | undefined;
};
const testEnv = env as unknown as MockedEnv;

describe('HMAC Utility', () => {
  it('generates a 64-hex-char SHA-256 signature', async () => {
    const sig = await generateHmac(
      { method: 'GET', path: '/api/v1/feed', timestamp: 1600000000, nonce: 'test-nonce', body: '' },
      'test-secret-key-32-bytes-long!!'
    );
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different signatures for different paths', async () => {
    const base = { method: 'GET', timestamp: 1600000000, nonce: 'n', body: '' };
    const sig1 = await generateHmac({ ...base, path: '/api/v1/feed' }, 'secret');
    const sig2 = await generateHmac({ ...base, path: '/api/v1/other' }, 'secret');
    expect(sig1).not.toBe(sig2);
  });

  it('produces different signatures for different secrets', async () => {
    const payload = { method: 'GET', path: '/api/v1/feed', timestamp: 1600000000, nonce: 'n', body: '' };
    const sig1 = await generateHmac(payload, 'secret-one');
    const sig2 = await generateHmac(payload, 'secret-two');
    expect(sig1).not.toBe(sig2);
  });

  it('is deterministic for identical inputs', async () => {
    const payload = { method: 'GET', path: '/api/v1/feed', timestamp: 1600000000, nonce: 'n', body: '' };
    const sig1 = await generateHmac(payload, 'secret');
    const sig2 = await generateHmac(payload, 'secret');
    expect(sig1).toBe(sig2);
  });
});

describe('BFF /api/feed Route', () => {
  beforeEach(() => {
    testEnv.HMAC_SECRET = undefined;
    testEnv.BACKEND_API = undefined;
  });

  function makeRequest(url = 'http://localhost/api/feed') {
    const req = new Request(url);
    return Object.assign(req, { nextUrl: new URL(url) }) as unknown as import('next/server').NextRequest;
  }

  it('returns 500 when HMAC_SECRET is missing', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('Missing HMAC_SECRET');
  });

  it('returns 500 when BACKEND_API binding is missing', async () => {
    testEnv.HMAC_SECRET = 'test-secret';
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('Missing BACKEND_API binding');
  });

  it('calls BACKEND_API.fetch with signed HMAC headers', async () => {
    testEnv.HMAC_SECRET = 'test-secret';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, headers: new Headers(),
      json: async () => ({ success: true, data: { items: [] } }),
    });

    testEnv.BACKEND_API = { fetch: mockFetch };

    const res = await GET(makeRequest('http://localhost/api/feed'));
    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean };
    expect(json.success).toBe(true);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const sentReq: Request = mockFetch.mock.calls[0][0];
    expect(sentReq.headers.get('X-HMAC-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(sentReq.headers.get('X-Nonce')).toBeTruthy();
    expect(sentReq.headers.get('X-Timestamp')).toBeTruthy();
  });
});

describe('BFF /api/saved Route', () => {
  beforeEach(() => {
    testEnv.HMAC_SECRET = 'test-secret';
    testEnv.BACKEND_API = {
      fetch: vi.fn().mockResolvedValue({
        ok: true, headers: new Headers(),
        json: async () => ({ id: 123 })
      })
    };
  });

  it('POST /api/saved calls BACKEND_API with valid signature', async () => {
    const req = new NextRequest('http://localhost/api/saved', {
      method: 'POST',
      body: JSON.stringify({ article_raw_id: 1 })
    });

    const res = await POST_SAVED(req);
    expect(res.status).toBe(200);

    const mockFetch = testEnv.BACKEND_API!.fetch;
    const sentReq = mockFetch.mock.calls[0][0];

    expect(sentReq.url).toBe('http://backend/api/v1/saved');
    expect(sentReq.method).toBe('POST');
    expect(sentReq.headers.get('X-HMAC-Signature')).toBeTruthy();
  });

  it('DELETE /api/saved/[id] calls BACKEND_API with valid signature and query param', async () => {
    const req = new NextRequest('http://localhost/api/saved/123', { method: 'DELETE' });
    const res = await DELETE_SAVED(req, { params: { id: '123' } });

    expect(res.status).toBe(200);

    const mockFetch = testEnv.BACKEND_API!.fetch;
    const sentReq = mockFetch.mock.calls[0][0];

    expect(sentReq.url).toBe('http://backend/api/v1/saved/123?user_id=test-user-id');
    expect(sentReq.method).toBe('DELETE');
    expect(sentReq.headers.get('X-HMAC-Signature')).toBeTruthy();
  });
});

describe('BFF /api/hide Route', () => {
  beforeEach(() => {
    testEnv.HMAC_SECRET = 'test-secret';
    testEnv.BACKEND_API = {
      fetch: vi.fn().mockResolvedValue({
        ok: true, headers: new Headers(),
        json: async () => ({ id: 456 })
      })
    };
  });

  it('POST /api/hide calls BACKEND_API with valid signature', async () => {
    const req = new NextRequest('http://localhost/api/hide', {
      method: 'POST',
      body: JSON.stringify({ article_raw_id: 1 })
    });

    const res = await POST_HIDE(req);
    expect(res.status).toBe(200);

    const mockFetch = testEnv.BACKEND_API!.fetch;
    const sentReq = mockFetch.mock.calls[0][0];

    expect(sentReq.url).toBe('http://backend/api/v1/hide');
    expect(sentReq.method).toBe('POST');
    expect(sentReq.headers.get('X-HMAC-Signature')).toBeTruthy();
  });
});

describe('BFF Header Hardening', () => {
  beforeEach(() => {
    testEnv.HMAC_SECRET = 'test-secret';
    testEnv.BACKEND_API = {
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({
          'X-RateLimit-Limit': '100',
          'X-RateLimit-Remaining': '99',
          'X-RateLimit-Reset': '1234567890',
          'Content-Type': 'application/json'
        }),
        json: async () => ({ success: true }),
        text: async () => '{"success":true}'
      })
    };
  });

  function makeRequest(url = 'http://localhost/api/feed', headers: Record<string, string> = {}) {
    const req = new Request(url, { headers });
    return Object.assign(req, { nextUrl: new URL(url) }) as unknown as import('next/server').NextRequest;
  }

  it('forwards CF-Connecting-IP to backend', async () => {
    const req = makeRequest('http://localhost/api/feed', { 'cf-connecting-ip': '1.2.3.4' });
    await GET(req);

    const mockFetch = testEnv.BACKEND_API!.fetch;
    const sentReq: Request = mockFetch.mock.calls[0][0];

    expect(sentReq.headers.get('cf-connecting-ip')).toBe('1.2.3.4');
  });

  it('forwards X-Forwarded-For to backend when CF-Connecting-IP is absent', async () => {
    const req = makeRequest('http://localhost/api/feed', { 'x-forwarded-for': '5.6.7.8' });
    await GET(req);

    const mockFetch = testEnv.BACKEND_API!.fetch;
    const sentReq: Request = mockFetch.mock.calls[0][0];

    expect(sentReq.headers.get('cf-connecting-ip')).toBeNull();
    expect(sentReq.headers.get('x-forwarded-for')).toBe('5.6.7.8');
  });

  it('does not fabricate client IP headers when none exist', async () => {
    const req = makeRequest('http://localhost/api/feed', {});
    await GET(req);

    const mockFetch = testEnv.BACKEND_API!.fetch;
    const sentReq: Request = mockFetch.mock.calls[0][0];

    expect(sentReq.headers.get('cf-connecting-ip')).toBeNull();
    expect(sentReq.headers.get('x-forwarded-for')).toBeNull();
  });

  it('propagates backend X-RateLimit-* response headers to the client', async () => {
    const req = makeRequest('http://localhost/api/feed', {});
    const res = await GET(req);

    expect(res.headers.get('X-RateLimit-Limit')).toBe('100');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('99');
    expect(res.headers.get('X-RateLimit-Reset')).toBe('1234567890');
    expect(res.headers.get('Content-Type')).toBe('application/json');
  });

  it('preserves response status', async () => {
    testEnv.BACKEND_API = {
      fetch: vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Headers({
          'X-RateLimit-Limit': '100',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': '1234567890',
        }),
        json: async () => ({ error: 'Too Many Requests' }),
        text: async () => '{"error":"Too Many Requests"}'
      })
    };

    const req = makeRequest('http://localhost/api/feed', {});
    const res = await GET(req);

    expect(res.status).toBe(429);
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
  });

  it('existing JSON body behavior is unchanged', async () => {
    const req = makeRequest('http://localhost/api/feed', {});
    const res = await GET(req);

    const json = await res.json() as { success: boolean };
    expect(json.success).toBe(true);
  });
});

describe('Phase 11A — BFF Identity & Follows', () => {
  beforeEach(() => {
    testEnv.HMAC_SECRET = 'test-secret-key-32-bytes-long!!';
    testEnv.BACKEND_API = {
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({
          'Content-Type': 'application/json',
          'X-RateLimit-Limit': '100',
          'X-RateLimit-Remaining': '99',
          'X-RateLimit-Reset': '1234567890',
        }),
        json: async () => ({ success: true, data: [] }),
        text: async () => JSON.stringify({ success: true, data: [] }),
      }),
    };
  });

  function makeBffRequest(
    url = 'http://localhost/api/follows',
    headers: Record<string, string> = {},
    method = 'GET',
    body?: unknown
  ) {
    const init: RequestInit = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      (init.headers as Record<string, string>)['content-type'] = 'application/json';
    }
    const req = new Request(url, init);
    return Object.assign(req, { nextUrl: new URL(url) }) as unknown as import('next/server').NextRequest;
  }

  it('binds userId into HMAC when present', async () => {
    const payloadWithout = { method: 'GET', path: '/api/v1/follows', timestamp: 1600000000, nonce: 'n', body: '' };
    const payloadWith = { ...payloadWithout, userId: 'test-user-id' };
    const sigWithout = await generateHmac(payloadWithout, 'secret');
    const sigWith = await generateHmac(payloadWith, 'secret');
    expect(sigWith).not.toBe(sigWithout);
    expect(sigWith).toMatch(/^[0-9a-f]{64}$/);
  });

  it('GET /api/follows propagates authenticated user ID and signature to backend', async () => {
    const req = makeBffRequest('http://localhost/api/follows?target_type=topic');
    const res = await GET_FOLLOWS(req);
    expect(res.status).toBe(200);

    const mockFetch = testEnv.BACKEND_API!.fetch;
    expect(mockFetch).toHaveBeenCalled();
    const sentReq: Request = mockFetch.mock.calls[0][0];

    expect(sentReq.headers.get('X-Authenticated-User-Id')).toBe('test-user-id');
    expect(sentReq.headers.get('X-HMAC-Signature')).toBeDefined();
    expect(sentReq.url).toContain('/api/v1/follows?user_id=test-user-id&target_type=topic');
  });

  it('POST /api/follows validates required fields and forwards authenticated body', async () => {
    const reqInvalid = makeBffRequest('http://localhost/api/follows', {}, 'POST', {});
    const resInvalid = await POST_FOLLOWS(reqInvalid);
    expect(resInvalid.status).toBe(400);

    const reqValid = makeBffRequest('http://localhost/api/follows', {}, 'POST', {
      target_type: 'topic',
      target_id: 'ai-news',
    });
    const resValid = await POST_FOLLOWS(reqValid);
    expect(resValid.status).toBe(200);

    const mockFetch = testEnv.BACKEND_API!.fetch;
    const sentReq: Request = mockFetch.mock.calls[0][0];
    expect(sentReq.headers.get('X-Authenticated-User-Id')).toBe('test-user-id');
    const sentBody = await sentReq.json();
    expect(sentBody.user_id).toBe('test-user-id');
    expect(sentBody.target_type).toBe('topic');
    expect(sentBody.target_id).toBe('ai-news');
  });

  it('DELETE /api/follows forwards target query params and authenticated header', async () => {
    const req = makeBffRequest('http://localhost/api/follows?target_type=topic&target_id=ai-news', {}, 'DELETE');
    const res = await DELETE_FOLLOWS(req);
    expect(res.status).toBe(200);

    const mockFetch = testEnv.BACKEND_API!.fetch;
    const sentReq: Request = mockFetch.mock.calls[0][0];
    expect(sentReq.headers.get('X-Authenticated-User-Id')).toBe('test-user-id');
    expect(sentReq.url).toContain('target_type=topic');
    expect(sentReq.url).toContain('target_id=ai-news');
  });

  it('POST /api/saved binds X-Authenticated-User-Id', async () => {
    const req = makeBffRequest('http://localhost/api/saved', {}, 'POST', { article_raw_id: 123 });
    const res = await POST_SAVED(req);
    expect(res.status).toBe(200);

    const mockFetch = testEnv.BACKEND_API!.fetch;
    const sentReq: Request = mockFetch.mock.calls[0][0];
    expect(sentReq.headers.get('X-Authenticated-User-Id')).toBe('test-user-id');
  });

  it('DELETE /api/saved/:id binds X-Authenticated-User-Id', async () => {
    const req = makeBffRequest('http://localhost/api/saved/123', {}, 'DELETE');
    const res = await DELETE_SAVED(req, { params: { id: '123' } });
    expect(res.status).toBe(200);

    const mockFetch = testEnv.BACKEND_API!.fetch;
    const sentReq: Request = mockFetch.mock.calls[0][0];
    expect(sentReq.headers.get('X-Authenticated-User-Id')).toBe('test-user-id');
  });

  it('POST /api/hide binds X-Authenticated-User-Id', async () => {
    const req = makeBffRequest('http://localhost/api/hide', {}, 'POST', { article_raw_id: 123 });
    const res = await POST_HIDE(req);
    expect(res.status).toBe(200);

    const mockFetch = testEnv.BACKEND_API!.fetch;
    const sentReq: Request = mockFetch.mock.calls[0][0];
    expect(sentReq.headers.get('X-Authenticated-User-Id')).toBe('test-user-id');
  });

  describe('BFF /api/feed/for-you Route', () => {
    it('returns 500 when HMAC_SECRET is missing', async () => {
      testEnv.HMAC_SECRET = undefined;
      const req = makeBffRequest('http://localhost/api/feed/for-you');
      const res = await GET_FOR_YOU(req);
      expect(res.status).toBe(500);
      const json = await res.json() as { error: string };
      expect(json.error).toBe('Missing HMAC_SECRET');
    });

    it('returns 500 when BACKEND_API is missing', async () => {
      testEnv.HMAC_SECRET = 'test-secret';
      testEnv.BACKEND_API = undefined;
      const req = makeBffRequest('http://localhost/api/feed/for-you');
      const res = await GET_FOR_YOU(req);
      expect(res.status).toBe(500);
      const json = await res.json() as { error: string };
      expect(json.error).toBe('Missing BACKEND_API binding');
    });

    it('forwards request with signed HMAC, user ID, and pagination', async () => {
      testEnv.HMAC_SECRET = 'test-secret';
      testEnv.BACKEND_API = {
        fetch: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ success: true, data: { items: [], meta: { total: 0, limit: 10, offset: 5, user_has_follows: false, fallback_applied: false } } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        ),
      };

      const req = makeBffRequest('http://localhost/api/feed/for-you?limit=10&offset=5');
      const res = await GET_FOR_YOU(req);
      expect(res.status).toBe(200);

      const mockFetch = testEnv.BACKEND_API!.fetch;
      expect(mockFetch).toHaveBeenCalled();
      const sentReq: Request = mockFetch.mock.calls[0][0];
      expect(sentReq.headers.get('X-Authenticated-User-Id')).toBe('test-user-id');
      expect(sentReq.headers.get('X-HMAC-Signature')).toBeDefined();
      expect(sentReq.url).toContain('/api/v1/feed/for-you?limit=10&offset=5');
      expect(res.headers.get('Cache-Control')).toBe('private, no-cache, no-store, must-revalidate');
    });

    it('handles backend error response properly', async () => {
      testEnv.HMAC_SECRET = 'test-secret';
      testEnv.BACKEND_API = {
        fetch: vi.fn().mockResolvedValue(
          new Response('Unauthorized error', { status: 401 })
        ),
      };

      const req = makeBffRequest('http://localhost/api/feed/for-you');
      const res = await GET_FOR_YOU(req);
      expect(res.status).toBe(401);
      const json = await res.json() as { error: string };
      expect(json.error).toContain('Backend error: 401');
    });
  });
});

