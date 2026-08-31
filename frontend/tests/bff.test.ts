import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateHmac } from '../src/utils/hmac';
import { GET } from '../src/app/api/feed/route';
import { env } from 'cloudflare:workers';

vi.mock('cloudflare:workers', () => ({
  env: {
    HMAC_SECRET: undefined,
    BACKEND_API: undefined,
  },
}));

// ---- HMAC Utility Tests -----------------------------------------------

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

// ---- BFF Route Tests ---------------------------------------------------

describe('BFF /api/feed Route', () => {
  beforeEach(() => {
    // Clear both so each test starts clean.

    (env as any).HMAC_SECRET = undefined;

    (env as any).BACKEND_API = undefined;
  });

  afterEach(() => {

    (env as any).HMAC_SECRET = undefined;

    (env as any).BACKEND_API = undefined;
  });

  function makeRequest(url = 'http://localhost/api/feed') {
    const req = new Request(url);
    // Attach nextUrl as required by the BFF route (NextRequest interface).
    return Object.assign(req, { nextUrl: new URL(url) }) as unknown as import('next/server').NextRequest;
  }

  it('returns 500 when HMAC_SECRET is missing', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('Missing HMAC_SECRET');
  });

  it('returns 500 when BACKEND_API binding is missing', async () => {

    env.HMAC_SECRET = 'test-secret';
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('Missing BACKEND_API binding');
  });

  it('calls BACKEND_API.fetch with signed HMAC headers', async () => {

    env.HMAC_SECRET = 'test-secret';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { items: [] } }),
    });

    env.BACKEND_API = { fetch: mockFetch };

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

  it('forwards query params to BACKEND_API and uses correct path', async () => {

    env.HMAC_SECRET = 'test-secret';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { items: [] } }),
    });

    env.BACKEND_API = { fetch: mockFetch };

    await GET(makeRequest('http://localhost/api/feed?limit=5&offset=10'));

    const sentReq: Request = mockFetch.mock.calls[0][0];
    expect(sentReq.url).toBe('http://backend/api/v1/feed?limit=5&offset=10');
  });

  it('returns backend error status when BACKEND_API call fails', async () => {

    env.HMAC_SECRET = 'test-secret';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    env.BACKEND_API = { fetch: mockFetch };

    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    const json = await res.json() as { error: string };
    expect(json.error).toContain('Backend error: 401');
  });
});
