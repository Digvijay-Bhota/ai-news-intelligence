import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GET, PATCH } from '../src/app/api/v1/community/profile/route';
import { env } from 'cloudflare:workers';
import { NextRequest } from 'next/server';
import { getOrCreateUserId } from '../src/lib/session';

vi.mock('../src/lib/session', () => ({
  getOrCreateUserId: vi.fn(() => 'test-user-id')
}));

vi.mock('cloudflare:workers', () => ({
  env: {
    HMAC_SECRET: undefined,
    BACKEND_API: undefined,
  },
}));

describe('Community Profile BFF Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (env as any).HMAC_SECRET = 'test-secret';
    (env as any).BACKEND_API = {
      fetch: vi.fn(async () => new Response(JSON.stringify({ public_id: 'test-public', display_name: 'Test Name' }), { status: 200 }))
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GET /api/v1/community/profile success', async () => {
    const req = new NextRequest('http://localhost/api/v1/community/profile');
    const res = await GET(req);
    
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('private');
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    
    const body = await res.json();
    expect(body.public_id).toBe('test-public');
    
    // Check backend request
    const mockFetch = (env as any).BACKEND_API.fetch;
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const backendReq = mockFetch.mock.calls[0][0] as Request;
    expect(backendReq.headers.get('X-Authenticated-User-Id')).toBe('test-user-id');
    expect(backendReq.headers.get('X-HMAC-Signature')).toBeTruthy();
  });

  it('PATCH /api/v1/community/profile success', async () => {
    const req = new NextRequest('http://localhost/api/v1/community/profile', {
      method: 'PATCH',
      body: JSON.stringify({ display_name: 'New Name', user_id: 'forged-id' })
    });
    
    const res = await PATCH(req);
    expect(res.status).toBe(200);
    
    // Check backend request
    const mockFetch = (env as any).BACKEND_API.fetch;
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const backendReq = mockFetch.mock.calls[0][0] as Request;
    
    expect(backendReq.headers.get('X-Authenticated-User-Id')).toBe('test-user-id');
    
    const reqBody = await backendReq.json();
    // user_id should be ignored
    expect(reqBody.display_name).toBe('New Name');
    expect(reqBody.user_id).toBeUndefined();
  });

  it('rejects if HMAC_SECRET missing', async () => {
    (env as any).HMAC_SECRET = '';
    const req = new NextRequest('http://localhost/api/v1/community/profile');
    const res = await GET(req);
    expect(res.status).toBe(500);
  });
});
