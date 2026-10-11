import { describe, it, expect, vi } from 'vitest';
import { handleModerateCommunityPost } from '../src/community';
import { BadRequestError } from '../src/utils/errors';
import type { Env } from '../src/types';
import type { AuthContext } from '../src/middleware/auth';

describe('handleModerateCommunityPost', () => {
  const createMockEnv = (initialStatus: string) => {
    const dbRows: any[] = [];
    const dbMock = {
      prepare: vi.fn((query: string) => {
        if (query.includes('SELECT status')) {
          return {
            bind: vi.fn().mockReturnThis(),
            first: vi.fn().mockResolvedValue(initialStatus === 'not_found' ? null : { status: initialStatus })
          };
        } else if (query.includes('UPDATE') || query.includes('INSERT')) {
          return {
            bind: vi.fn((...args: any[]) => {
              dbRows.push(args);
              return { run: vi.fn().mockResolvedValue(undefined) };
            })
          };
        }
        return { bind: vi.fn().mockReturnThis(), first: vi.fn(), run: vi.fn() };
      })
    };
    // handleModerateCommunityPost reads env.DB.prepare(...), so the mock must be
    // wrapped under a DB property to match the real Env shape, not passed bare.
    const env = { DB: dbMock } as unknown as Env;
    return { env, rows: dbRows };
  };

  const createRequest = (status: string) => {
    return new Request('https://api.test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
  };

  it('active -> flagged', async () => {
    const { env, rows } = createMockEnv('active');
    const auth: AuthContext = { identifier: 'sys', scopes: ['internal'], isInternal: true };
    await handleModerateCommunityPost(createRequest('flagged'), env, auth, 'post_1');
    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual(['flagged', 'post_1']);
    expect(rows[1]).toEqual(['post_1', 'sys', 'SYSTEM', 'active', 'flagged', 'Moderation action']);
  });

  it('flagged -> active', async () => {
    const { env, rows } = createMockEnv('flagged');
    const auth: AuthContext = { identifier: 'sys', scopes: ['internal'], isInternal: true };
    await handleModerateCommunityPost(createRequest('active'), env, auth, 'post_1');
    expect(rows[0]).toEqual(['active', 'post_1']);
  });

  it('flagged -> hidden', async () => {
    const { env, rows } = createMockEnv('flagged');
    const auth: AuthContext = { identifier: 'sys', scopes: ['internal'], isInternal: true };
    await handleModerateCommunityPost(createRequest('hidden'), env, auth, 'post_1');
    expect(rows[0]).toEqual(['hidden', 'post_1']);
  });

  it('hidden -> active', async () => {
    const { env, rows } = createMockEnv('hidden');
    const auth: AuthContext = { identifier: 'sys', scopes: ['internal'], isInternal: true };
    await handleModerateCommunityPost(createRequest('active'), env, auth, 'post_1');
    expect(rows[0]).toEqual(['active', 'post_1']);
  });

  it('admin audit records ADMIN', async () => {
    const { env, rows } = createMockEnv('active');
    const auth: AuthContext = { identifier: 'admin_usr', scopes: ['admin'], isInternal: true };
    await handleModerateCommunityPost(createRequest('hidden'), env, auth, 'post_1');
    expect(rows[1][2]).toBe('ADMIN');
  });

  it('moderator audit records MODERATOR', async () => {
    const { env, rows } = createMockEnv('active');
    const auth: AuthContext = { identifier: 'mod_usr', scopes: ['moderator'], isInternal: true };
    await handleModerateCommunityPost(createRequest('flagged'), env, auth, 'post_1');
    expect(rows[1][2]).toBe('MODERATOR');
  });

  it('invalid transitions rejected', async () => {
    const { env } = createMockEnv('active');
    const auth: AuthContext = { identifier: 'mod', scopes: ['moderator'], isInternal: true };
    await expect(handleModerateCommunityPost(createRequest('unknown'), env, auth, 'post_1')).rejects.toThrow(BadRequestError);
  });
  
  it('cannot transition from hidden to flagged', async () => {
    const { env } = createMockEnv('hidden');
    const auth: AuthContext = { identifier: 'mod', scopes: ['moderator'], isInternal: true };
    await expect(handleModerateCommunityPost(createRequest('flagged'), env, auth, 'post_1')).rejects.toThrow(BadRequestError);
  });

  it('deleted content cannot be resurrected', async () => {
    const { env } = createMockEnv('deleted');
    const auth: AuthContext = { identifier: 'admin', scopes: ['admin'], isInternal: true };
    await expect(handleModerateCommunityPost(createRequest('active'), env, auth, 'post_1')).rejects.toThrow(BadRequestError);
  });
});
