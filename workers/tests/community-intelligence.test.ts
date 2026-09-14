import { describe, it, expect } from 'vitest';
import { computeCommunityMetrics, handleGenerateCommunityIntelligence, handleGetCommunityIntelligence } from '../src/community';
import { Env, ApiResponse } from '../src/types';
import { AuthContext } from '../src/middleware/auth';

describe('Community Intelligence Metrics', () => {
  it('computes metrics excluding flagged/hidden/deleted and distinct participants', async () => {
    // We will mock the DB calls directly to ensure they are calling what we expect
    let queries: string[] = [];
    
    const dbMock = {
      prepare: (q: string) => {
        queries.push(q);
        return {
          bind: () => ({
            first: async () => {
              if (q.includes('COUNT(id) as total_posts')) return { total_posts: 10, total_users: 5 };
              if (q.includes('COUNT(id) as posts_24h')) return { posts_24h: 4, users_24h: 3 };
              if (q.includes('COUNT(id) as posts_prev_24h')) return { posts_prev_24h: 2 };
              if (q.includes('SELECT id FROM events')) return { id: 101 };
              if (q.includes('SELECT * FROM community_metrics_snapshots')) return { event_id: 101, lifetime_posts: 10, lifetime_participants: 5, posts_last_24h: 4, participants_last_24h: 3, momentum_score: 6.0 };
              return null;
            },
            run: async () => ({ success: true })
          })
        }
      }
    };
    
    const env = { DB: dbMock } as unknown as Env;

    const snapshot = await computeCommunityMetrics(env, 101);
    
    // Assert metrics returned
    expect(snapshot!.lifetime_posts).toBe(10);
    expect(snapshot!.lifetime_participants).toBe(5);
    expect(snapshot!.momentum_score).toBe(6.0); // (4 / 2) * 3 = 6
    
    // Check that we only queried for 'active' status
    const postQueries = queries.filter(q => q.includes('community_posts'));
    postQueries.forEach(q => {
      if (!q.includes('INSERT')) {
        expect(q).toContain("status = 'active'");
        expect(q).not.toContain("flagged");
        expect(q).not.toContain("hidden");
      }
    });

    // Check zero denominator behavior (12 / max(1, 0)) * 2
    const zeroDenomDbMock = {
      prepare: (q: string) => {
        return {
          bind: () => ({
            first: async () => {
              if (q.includes('COUNT(id) as total_posts')) return { total_posts: 12, total_users: 2 };
              if (q.includes('COUNT(id) as posts_24h')) return { posts_24h: 12, users_24h: 2 };
              if (q.includes('COUNT(id) as posts_prev_24h')) return { posts_prev_24h: 0 }; // Zero denominator
              if (q.includes('SELECT * FROM community_metrics_snapshots')) return { event_id: 101, momentum_score: 24.0 };
              return null;
            },
            run: async () => ({ success: true })
          })
        }
      }
    };
    const envZero = { DB: zeroDenomDbMock } as unknown as Env;
    const snapZero = await computeCommunityMetrics(envZero, 101);
    expect(snapZero!.momentum_score).toBe(24.0);
  });
  
  it('Internal generation rejects unauthorized', async () => {
    const auth: AuthContext = { userId: '1', identifier: 'x', scopes: ['user'], isInternal: true };
    const env = { DB: {} } as unknown as Env;
    await expect(handleGenerateCommunityIntelligence(new Request('http://test'), env, auth, 'hash')).rejects.toThrowError('Requires internal/admin scope');
  });

  it('Public API returns clean snapshot', async () => {
    const dbMock = {
      prepare: (q: string) => {
        return {
          bind: () => ({
            first: async () => {
              if (q.includes('SELECT id FROM events')) return { id: 101 };
              if (q.includes('SELECT * FROM community_metrics_snapshots')) return { event_id: 101, lifetime_posts: 10, lifetime_participants: 5, posts_last_24h: 4, participants_last_24h: 3, momentum_score: 6.0 };
              return null;
            }
          })
        }
      }
    };
    const env = { DB: dbMock } as unknown as Env;
    const req = new Request('http://test');
    const res = await handleGetCommunityIntelligence(req, env, 'hash');
    const data = await res.json() as ApiResponse<{metrics: any}>;
    expect(data.data!.metrics.lifetime_posts).toBe(10);
    // Ensure cache header is present
    expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=300');
  });
});
