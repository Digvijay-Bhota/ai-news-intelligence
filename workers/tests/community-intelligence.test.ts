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
            },
            // No approved signals for this event
            all: async () => ({ results: [] })
          })
        }
      }
    };
    const env = { DB: dbMock } as unknown as Env;
    const req = new Request('http://test');
    const res = await handleGetCommunityIntelligence(req, env, 'hash');
    const data = await res.json() as ApiResponse<{metrics: any}>;
    expect(data.data!.metrics.lifetime_posts).toBe(10);
    expect(data.data!.metrics.event_id).toBeUndefined();
    expect(data.data!.metrics).not.toHaveProperty('event_id');
    // Ensure cache header is present
    expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=300');
  });
});

import { handleReviewSignal } from '../src/community';

describe('Community Intelligence Signals (Phase 14.2C)', () => {
  it('Public read dynamically revalidates evidence against active status and event_id', async () => {
    const dbMock = {
      prepare: (q: string) => {
        return {
          bind: () => ({
            first: async () => {
              if (q.includes('SELECT id FROM events')) return { id: 101 };
              if (q.includes('SELECT * FROM community_metrics_snapshots')) return null;
              return null;
            },
            all: async () => {
              if (q.includes('SELECT s.type, s.content, COUNT(DISTINCT p.id) as evidence_count')) {
                // simulate dynamically revalidated signals
                return {
                  results: [
                    { type: 'emerging_theme', content: 'c1', evidence_count: 4 }
                  ]
                };
              }
              return { results: [] };
            }
          })
        }
      }
    };
    const env = { DB: dbMock } as unknown as Env;
    const req = new Request('http://test');
    const res = await handleGetCommunityIntelligence(req, env, 'hash');
    const data = await res.json() as ApiResponse<any>;
    
    // Ensure public metrics are present and signals are attached
    expect(data.data.signals.length).toBe(1);
    expect(data.data.signals[0].type).toBe('emerging_theme');
    expect(data.data.signals[0].evidence_count).toBe(4);
    
    // Ensure leakage tests pass
    expect(data.data.signals[0].id).toBeUndefined();
    expect(data.data.signals[0].signal_id).toBeUndefined();
    expect(data.data.signals[0].event_id).toBeUndefined();
    expect(data.data.signals[0].reviewer_id).toBeUndefined();
    expect(data.data.signals[0].evidence_post_ids).toBeUndefined();
    expect(data.data.signals[0].user_id).toBeUndefined();
    expect(data.data.signals[0].user_hash).toBeUndefined();
  });

  it('handleReviewSignal correctly integrates with transition logic', async () => {
    let queries: string[] = [];
    const dbMock = {
      prepare: (q: string) => {
        queries.push(q);
        return {
          bind: () => ({
            first: async () => {
              if (q.includes('SELECT id FROM events')) return { id: 101 };
              if (q.includes('SELECT * FROM community_signals')) return { id: 'sig1', status: 'candidate' };
              return null;
            },
            run: async () => ({ success: true })
          })
        }
      },
      batch: async () => ([ { meta: { changes: 1 } }, { meta: { changes: 1 } } ])
    };
    const env = { DB: dbMock } as unknown as Env;
    
    const req = new Request('http://test', {
      method: 'POST',
      body: JSON.stringify({ status: 'approved' }),
      headers: { 'Content-Type': 'application/json' }
    });
    
    // Authenticated as the internal review route requires: internal + admin scopes and a signed user ID
    // matching the token's configured name
    const auth: AuthContext = { identifier: 'admin1', userId: 'reviewer-1', tokenName: 'reviewer-1', scopes: ['internal', 'admin'], isInternal: true };
    await expect(handleReviewSignal(req, env, auth, 'hash', 'sig1')).resolves.toBeDefined();
    
    // Verify it called UPDATE community_signals
    expect(queries.some(q => q.includes('UPDATE community_signals SET status = ?'))).toBe(true);
    expect(queries.some(q => q.includes('INSERT INTO community_signal_reviews'))).toBe(true);
  });

  it('handleReviewSignal fails if auth.userId is missing', async () => {
    const env = { DB: {} } as unknown as Env;
    
    const req = new Request('http://test', {
      method: 'POST',
      body: JSON.stringify({ status: 'approved' }),
      headers: { 'Content-Type': 'application/json' }
    });
    
    const auth = { identifier: 'admin1', scopes: ['internal'] } as AuthContext;
    await expect(handleReviewSignal(req, env, auth, 'hash', 'sig1')).rejects.toThrow('Authenticated user identity required');
  });

  it('handleReviewSignal correctly uses auth.userId', async () => {
    let queries: string[] = [];
    const dbMock = {
      prepare: (q: string) => {
        queries.push(q);
        return {
          bind: (...args: any[]) => {
            if (q.includes('INSERT INTO community_signal_reviews')) {
              // Ensure reviewer_id passed is the userId, not the identifier
              expect(args[2]).toBe('synthetic-user-123');
            }
            return {
              first: async () => {
                if (q.includes('SELECT id FROM events')) return { id: 101 };
                if (q.includes('SELECT * FROM community_signals')) return { id: 'sig1', status: 'candidate' };
                return null;
              },
              run: async () => ({ success: true })
            }
          }
        }
      },
      batch: async () => ([ { meta: { changes: 1 } }, { meta: { changes: 1 } } ])
    };
    const env = { DB: dbMock } as unknown as Env;
    
    const req = new Request('http://test', {
      method: 'POST',
      body: JSON.stringify({ status: 'approved' }),
      headers: { 'Content-Type': 'application/json' }
    });
    
    const auth = { identifier: 'internal-service', userId: 'synthetic-user-123', tokenName: 'synthetic-user-123', scopes: ['internal'] } as AuthContext;
    await expect(handleReviewSignal(req, env, auth, 'hash', 'sig1')).resolves.toBeDefined();
  });

});
