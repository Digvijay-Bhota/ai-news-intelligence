import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateHmac } from '../src/utils/hmac';
import { GET } from '../src/app/api/feed/route';
import { POST as POST_SAVED } from '../src/app/api/saved/route';
import { DELETE as DELETE_SAVED } from '../src/app/api/saved/[id]/route';
import { POST as POST_HIDE } from '../src/app/api/hide/route';
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
    (env as any).HMAC_SECRET = undefined;
    (env as any).BACKEND_API = undefined;
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
    (env as any).HMAC_SECRET = 'test-secret';
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('Missing BACKEND_API binding');
  });

  it('calls BACKEND_API.fetch with signed HMAC headers', async () => {
    (env as any).HMAC_SECRET = 'test-secret';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { items: [] } }),
    });

    (env as any).BACKEND_API = { fetch: mockFetch };

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
    (env as any).HMAC_SECRET = 'test-secret';
    (env as any).BACKEND_API = {
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 123 })
      })
    };
  });

  it('POST /api/saved calls BACKEND_API with valid signature', async () => {
    const req = new Request('http://localhost/api/saved', {
      method: 'POST',
      body: JSON.stringify({ article_raw_id: 1 })
    });

    const res = await POST_SAVED(req as any);
    expect(res.status).toBe(200);

    const mockFetch = (env as any).BACKEND_API.fetch;
    const sentReq = mockFetch.mock.calls[0][0];

    expect(sentReq.url).toBe('http://backend/api/v1/saved');
    expect(sentReq.method).toBe('POST');
    expect(sentReq.headers.get('X-HMAC-Signature')).toBeTruthy();
  });

  it('DELETE /api/saved/[id] calls BACKEND_API with valid signature and query param', async () => {
    const req = new Request('http://localhost/api/saved/123', { method: 'DELETE' });
    const res = await DELETE_SAVED(req as any, { params: { id: '123' } });

    expect(res.status).toBe(200);

    const mockFetch = (env as any).BACKEND_API.fetch;
    const sentReq = mockFetch.mock.calls[0][0];

    expect(sentReq.url).toBe('http://backend/api/v1/saved/123?user_id=test-user-id');
    expect(sentReq.method).toBe('DELETE');
    expect(sentReq.headers.get('X-HMAC-Signature')).toBeTruthy();
  });
});

describe('BFF /api/hide Route', () => {
  beforeEach(() => {
    (env as any).HMAC_SECRET = 'test-secret';
    (env as any).BACKEND_API = {
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 456 })
      })
    };
  });

  it('POST /api/hide calls BACKEND_API with valid signature', async () => {
    const req = new Request('http://localhost/api/hide', {
      method: 'POST',
      body: JSON.stringify({ article_raw_id: 1 })
    });

    const res = await POST_HIDE(req as any);
    expect(res.status).toBe(200);

    const mockFetch = (env as any).BACKEND_API.fetch;
    const sentReq = mockFetch.mock.calls[0][0];

    expect(sentReq.url).toBe('http://backend/api/v1/hide');
    expect(sentReq.method).toBe('POST');
    expect(sentReq.headers.get('X-HMAC-Signature')).toBeTruthy();
  });
});
