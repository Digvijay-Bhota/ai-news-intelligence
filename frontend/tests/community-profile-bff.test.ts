import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { GET, PATCH } from '../src/app/api/v1/community/profile/route';
import { env } from 'cloudflare:workers';
import { NextRequest } from 'next/server';

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

describe('Community Profile BFF Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testEnv.HMAC_SECRET = 'test-secret';
    testEnv.BACKEND_API = {
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
    const mockFetch = testEnv.BACKEND_API!.fetch;
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
    const mockFetch = testEnv.BACKEND_API!.fetch;
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const backendReq = mockFetch.mock.calls[0][0] as Request;
    
    expect(backendReq.headers.get('X-Authenticated-User-Id')).toBe('test-user-id');
    
    const reqBody = await backendReq.json();
    // user_id should be ignored
    expect(reqBody.display_name).toBe('New Name');
    expect(reqBody.user_id).toBeUndefined();
  });

  it('rejects if HMAC_SECRET missing', async () => {
    testEnv.HMAC_SECRET = '';
    const req = new NextRequest('http://localhost/api/v1/community/profile');
    const res = await GET(req);
    expect(res.status).toBe(500);
  });
});
