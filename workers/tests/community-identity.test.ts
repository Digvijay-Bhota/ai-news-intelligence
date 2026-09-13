import { describe, it, expect } from 'vitest';
import { route } from '../src/router';
import { createMockEnv, createMockD1Database, createMockKVNamespace, TEST_SECRET } from './setup';
import { buildSignedRequest } from '../src/utils/hmac';

const mockEnv = createMockEnv({
  DB: createMockD1Database(true),
  CACHE: createMockKVNamespace(),
  HMAC_SECRET: TEST_SECRET,
});

async function signedRequest(
  url: string,
  method = 'GET',
  body?: Record<string, unknown>,
  explicitUserId?: string
): Promise<Request> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
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

describe('Community Identity API', () => {
  let userId1 = 'user-1';
  let userId2 = 'user-2';

  it('GET /api/v1/community/profile lazily creates profile with default name', async () => {
    const req = await signedRequest('http://localhost/api/v1/community/profile', 'GET', undefined, userId1);
    const res = await route(req, mockEnv);
    const data = await res.json() as any;
    if (res.status !== 200) {
      console.log('Error data:', data);
    }
    expect(res.status).toBe(200);
    
    expect(data.success).toBe(true);
    expect(data.data.public_id).toBeDefined();
    expect(data.data.public_id.length).toBeGreaterThanOrEqual(21);
    expect(data.data.display_name).toMatch(/^Reader_[A-Z0-9]{4}$/);
    expect(data.data.status).toBe('active');
    expect(data.data.user_id).toBeUndefined(); // Never expose internal ID
  });

  it('PATCH /api/v1/community/profile updates display name', async () => {
    const updateReq = await signedRequest('http://localhost/api/v1/community/profile', 'PATCH', { display_name: 'CoolReader' }, userId1);
    const updateRes = await route(updateReq, mockEnv);
    expect(updateRes.status).toBe(200);
    const updateData = await updateRes.json() as any;
    
    expect(updateData.success).toBe(true);
    expect(updateData.data.display_name).toBe('CoolReader');
    expect(updateData.data.public_id).toBeDefined();

    // Verify retrieval matches
    const getReq = await signedRequest('http://localhost/api/v1/community/profile', 'GET', undefined, userId1);
    const getRes = await route(getReq, mockEnv);
    const getData = await getRes.json() as any;
    expect(getData.data.display_name).toBe('CoolReader');
  });

  it('PATCH /api/v1/community/profile rejects invalid display names', async () => {
    const updateReq = await signedRequest('http://localhost/api/v1/community/profile', 'PATCH', { display_name: 'A' }, userId1);
    const updateRes = await route(updateReq, mockEnv);
    expect(updateRes.status).toBe(400);
  });
  it('GET /api/v1/community/profile twice returns same profile', async () => {
    const getReq1 = await signedRequest('http://localhost/api/v1/community/profile', 'GET', undefined, userId1);
    const res1 = await route(getReq1, mockEnv);
    const data1 = await res1.json() as any;

    const getReq2 = await signedRequest('http://localhost/api/v1/community/profile', 'GET', undefined, userId1);
    const res2 = await route(getReq2, mockEnv);
    const data2 = await res2.json() as any;

    expect(data1.data.public_id).toBe(data2.data.public_id);
    expect(data1.data.display_name).toBe(data2.data.display_name);
    expect(data1.data.status).toBe(data2.data.status);
  });

  it('PATCH cannot change public_id or user_id', async () => {
    const getReq1 = await signedRequest('http://localhost/api/v1/community/profile', 'GET', undefined, userId1);
    const res1 = await route(getReq1, mockEnv);
    const data1 = await res1.json() as any;

    const updateReq = await signedRequest('http://localhost/api/v1/community/profile', 'PATCH', { 
      display_name: 'Hacker',
      public_id: 'fake-public-id',
      user_id: 'fake-user-id'
    }, userId1);
    const updateRes = await route(updateReq, mockEnv);
    expect(updateRes.status).toBe(200);
    const updateData = await updateRes.json() as any;
    
    expect(updateData.data.public_id).toBe(data1.data.public_id);
    expect(updateData.data.user_id).toBeUndefined();
  });

  it('unauthenticated/invalid-auth request is rejected', async () => {
    const req = new Request('http://localhost/api/v1/community/profile');
    const res = await route(req, mockEnv);
    expect(res.status).toBe(401);
  });

  it('unsafe display names are rejected', async () => {
    const badNames = [
      '<script>alert(1)</script>',
      'Reader\nName',
      'Reader\rName',
      'Reader\u0000Name',
      '<>',
      '{}',
      '[]',
      '"quoted"'
    ];
    for (const name of badNames) {
      const updateReq = await signedRequest('http://localhost/api/v1/community/profile', 'PATCH', { display_name: name }, userId1);
      const updateRes = await route(updateReq, mockEnv);
      expect(updateRes.status).toBe(400);
    }
  });

  it('valid Unicode display names are accepted', async () => {
    const goodNames = [
      'Reader A9F2',
      'Reader_A9F2',
      'Tech Reader',
      'AI-Reader',
      'हिंदी Reader'
    ];
    for (const name of goodNames) {
      const updateReq = await signedRequest('http://localhost/api/v1/community/profile', 'PATCH', { display_name: name }, userId1);
      const updateRes = await route(updateReq, mockEnv);
      expect(updateRes.status).toBe(200);
    }
  });

  it('generic internal error response does not expose details', async () => {
    // Mock DB to throw a raw error for GET profile
    const badEnv = {
      ...mockEnv,
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => { throw new Error('SQLITE_ERROR: syntax error in test'); }
          })
        })
      } as any
    };
    
    const req = await signedRequest('http://localhost/api/v1/community/profile', 'GET', undefined, userId1);
    const res = await route(req, badEnv);
    expect(res.status).toBe(500);
    const data = await res.json() as any;
    expect(data.error).toBe('Internal Server Error');
    expect(data.error).not.toContain('SQLITE');
  });

  it('concurrent lazy-creation conflict resolves to existing profile', async () => {
    // We simulate this by directly throwing a UNIQUE constraint error when inserting,
    // which should be caught by our new logic and fallback to returning the existing profile.
    
    // First setup the profile properly
    await route(await signedRequest('http://localhost/api/v1/community/profile', 'GET', undefined, 'user-race'), mockEnv);
    
    // Now mock the env to always return null for getUserProfile on FIRST call, but throw constraint on INSERT
    let getCalls = 0;
    const raceEnv = {
      ...mockEnv,
      DB: {
        prepare: (query: string) => {
          if (query.includes('FROM USER_PROFILES WHERE USER_ID')) {
            return {
              bind: (...args: any[]) => ({
                first: async () => {
                  getCalls++;
                  if (getCalls === 1) return null;
                  return mockEnv.DB.prepare(query).bind(...args).first();
                }
              })
            };
          }
          if (query.includes('INSERT INTO user_profiles')) {
             return {
                bind: () => ({
                   first: async () => { throw new Error('UNIQUE constraint failed'); }
                })
             }
          }
          // fallback
          return mockEnv.DB.prepare(query);
        },
        batch: mockEnv.DB.batch,
        dump: mockEnv.DB.dump,
        exec: mockEnv.DB.exec,
      } as any
    };

    const req = await signedRequest('http://localhost/api/v1/community/profile', 'GET', undefined, 'user-race');
    const res = await route(req, raceEnv);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.data.public_id).toBeDefined();
  });

  it('cross-user identity isolation', async () => {
    const getReq1 = await signedRequest('http://localhost/api/v1/community/profile', 'GET', undefined, userId1);
    const res1 = await route(getReq1, mockEnv);
    const data1 = await res1.json() as any;
    
    const getReq2 = await signedRequest('http://localhost/api/v1/community/profile', 'GET', undefined, userId2);
    const res2 = await route(getReq2, mockEnv);
    const data2 = await res2.json() as any;

    expect(data1.data.public_id).not.toBe(data2.data.public_id);
    expect(data1.data.display_name).not.toBe(data2.data.display_name);
  });
});
