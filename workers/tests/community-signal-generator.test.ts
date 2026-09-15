import { describe, it, expect } from 'vitest';
import { generateCommunitySignalsForEvent } from '../src/tasks/community-signal-generator';

describe('community-signal-generator', () => {
    function createMockEnv(posts: any[], existingSignals: any[] = [], cursorState: any = null) {
        const statements: any[] = [];
        return {
            env: {
                DB: {
                    prepare: (q: string) => {
                        let binds: any[] = [];
                        return {
                            bind: (...args: any[]) => {
                                binds = args;
                                return {
                                    first: async () => {
                                        if (q.includes('community_signal_generation_state')) {
                                            return cursorState;
                                        }
                                        if (q.includes('SELECT created_at FROM community_posts')) {
                                            const p = posts.find(p => p.id === binds[0]);
                                            return p ? { created_at: p.created_at } : null;
                                        }
                                        return null;
                                    },
                                    all: async () => {
                                        if (q.includes('SELECT id, user_id, body, created_at')) {
                                            return { results: posts };
                                        }
                                        if (q.includes('SELECT id FROM community_posts WHERE id IN')) {
                                            // Validate active posts
                                            const ids = binds.slice(0, binds.length - 1);
                                            const valid = posts.filter(p => ids.includes(p.id) && p.status === 'active' && p.event_id === binds[binds.length - 1]);
                                            return { results: valid.map(v => ({id: v.id})) };
                                        }
                                        if (q.includes('SELECT id, type, content, status FROM community_signals')) {
                                            return { results: existingSignals };
                                        }
                                        return { results: [] };
                                    },
                                    run: async () => {}
                                }
                            }
                        }
                    },
                    batch: async (stmts: any[]) => {
                        statements.push(...stmts);
                    }
                }
            },
            statements
        } as any;
    }

    it('prompt anonymizes users safely and successfully persists', async () => {
        const posts = [
            { id: 'p1', user_id: 'real_user_id_1', body: 'text', created_at: 1000, event_id: 1, status: 'active' },
            { id: 'p2', user_id: 'real_user_id_2', body: 'text', created_at: 1001, event_id: 1, status: 'active' },
            { id: 'p3', user_id: 'real_user_id_3', body: 'text', created_at: 1002, event_id: 1, status: 'active' },
            { id: 'p4', user_id: 'real_user_id_1', body: 'text', created_at: 1003, event_id: 1, status: 'active' },
        ];
        const mockEnv = createMockEnv(posts);
        
        let capturedPrompt = '';
        await generateCommunitySignalsForEvent(mockEnv.env, 1, async (prompt) => {
            capturedPrompt = prompt;
            return JSON.stringify([{ type: 'emerging_theme', content: 'Valid theme', evidence_post_ids: ['p1', 'p2', 'p3'] }]);
        });
        
        // Ensure no raw user id is present
        expect(capturedPrompt).not.toContain('real_user_id_1');
        
        // Ensure same user -> same hash
        const p1Match = capturedPrompt.match(/"post_id": "p1",\s*"text": "text",\s*"user_hash": "([a-f0-9]+)"/);
        const p4Match = capturedPrompt.match(/"post_id": "p4",\s*"text": "text",\s*"user_hash": "([a-f0-9]+)"/);
        expect(p1Match![1]).toBe(p4Match![1]);
        
        // Ensure different users -> different hashes
        const p2Match = capturedPrompt.match(/"post_id": "p2",\s*"text": "text",\s*"user_hash": "([a-f0-9]+)"/);
        expect(p1Match![1]).not.toBe(p2Match![1]);
    });

    it('rejects extra fields', async () => {
        const posts = [
            { id: 'p1', user_id: 'u1', body: 't', created_at: 1000, event_id: 1, status: 'active' },
            { id: 'p2', user_id: 'u2', body: 't', created_at: 1001, event_id: 1, status: 'active' },
            { id: 'p3', user_id: 'u3', body: 't', created_at: 1002, event_id: 1, status: 'active' },
        ];
        const mockEnv = createMockEnv(posts);
        await expect(generateCommunitySignalsForEvent(mockEnv.env, 1, async () => JSON.stringify([{ type: 'emerging_theme', content: 'c', evidence_post_ids: ['p1', 'p2', 'p3'], extra: 'bad' }])))
            .rejects.toThrow('Proposal must contain exactly 3 fields');
    });

    it('does not mutate approved signals silently', async () => {
        const posts = [
            { id: 'p1', user_id: 'u1', body: 'text', created_at: 1000, event_id: 1, status: 'active' },
            { id: 'p2', user_id: 'u2', body: 'text', created_at: 1001, event_id: 1, status: 'active' },
            { id: 'p3', user_id: 'u3', body: 'text', created_at: 1002, event_id: 1, status: 'active' },
        ];
        const existingSignals = [
            { id: 'sig1', type: 'emerging_theme', content: 'Valid theme', status: 'approved' }
        ];

        const mockEnv = createMockEnv(posts, existingSignals);
        await generateCommunitySignalsForEvent(mockEnv.env, 1, async () => JSON.stringify([{ type: 'emerging_theme', content: 'Valid theme', evidence_post_ids: ['p1', 'p2', 'p3'] }]));
        
        // We expect a new candidate to be created instead of appended
        const insertSignal = mockEnv.statements.find((s: any) => s.q.includes('INSERT INTO community_signals'));
        expect(insertSignal).toBeDefined(); // A new candidate was made!
    });
    
    it('appends to candidate signals silently', async () => {
        const posts = [
            { id: 'p1', user_id: 'u1', body: 'text', created_at: 1000, event_id: 1, status: 'active' },
            { id: 'p2', user_id: 'u2', body: 'text', created_at: 1001, event_id: 1, status: 'active' },
            { id: 'p3', user_id: 'u3', body: 'text', created_at: 1002, event_id: 1, status: 'active' },
        ];
        const existingSignals = [
            { id: 'sig1', type: 'emerging_theme', content: 'Valid theme', status: 'candidate' }
        ];

        const mockEnv = createMockEnv(posts, existingSignals);
        await generateCommunitySignalsForEvent(mockEnv.env, 1, async () => JSON.stringify([{ type: 'emerging_theme', content: 'Valid theme', evidence_post_ids: ['p1', 'p2', 'p3'] }]));
        
        // We expect NO new candidate, but we do expect evidence appended
        const insertSignal = mockEnv.statements.find((s: any) => s.q.includes('INSERT INTO community_signals'));
        expect(insertSignal).toBeUndefined(); // NO new candidate!
        
        const insertEvidence = mockEnv.statements.find((s: any) => s.q.includes('INSERT OR IGNORE INTO community_signal_evidence'));
        expect(insertEvidence).toBeDefined(); // Evidence appended!
    });

    it('recovers cursor safely if post deleted', async () => {
        const posts = [
            { id: 'p1', user_id: 'u1', body: 'text', created_at: 1000, event_id: 1, status: 'active' },
            { id: 'p2', user_id: 'u2', body: 'text', created_at: 1001, event_id: 1, status: 'active' },
            { id: 'p3', user_id: 'u3', body: 'text', created_at: 1002, event_id: 1, status: 'active' },
        ];
        // Cursor post is missing from posts array, meaning it was deleted.
        // But the new cursor format is used, which stores time
        const cursorState = { last_processed_post_id: '999|old_post_id', updated_at: 123 };
        
        const mockEnv = createMockEnv(posts, [], cursorState);
        await generateCommunitySignalsForEvent(mockEnv.env, 1, async () => JSON.stringify([{ type: 'emerging_theme', content: 'Valid theme', evidence_post_ids: ['p1', 'p2', 'p3'] }]));
        
        // Ensures processing happens successfully using 999 as time limit.
        expect(mockEnv.statements.length).toBeGreaterThan(0);
        
        // Check new cursor format is written: created_at|id
        const cursorUpdate = mockEnv.statements.find((s: any) => s.q.includes('community_signal_generation_state'));
        expect(cursorUpdate.args[1]).toBe('1002|p3');
    });
    
    it('legacy cursor post deleted fallback to updated_at', async () => {
        const posts = [
            { id: 'p1', user_id: 'u1', body: 'text', created_at: 1000, event_id: 1, status: 'active' },
            { id: 'p2', user_id: 'u2', body: 'text', created_at: 1001, event_id: 1, status: 'active' },
            { id: 'p3', user_id: 'u3', body: 'text', created_at: 1002, event_id: 1, status: 'active' },
        ];
        // legacy cursor format (no pipe)
        const cursorState = { last_processed_post_id: 'old_missing_post', updated_at: 999 };
        
        const mockEnv = createMockEnv(posts, [], cursorState);
        await generateCommunitySignalsForEvent(mockEnv.env, 1, async () => JSON.stringify([{ type: 'emerging_theme', content: 'Valid theme', evidence_post_ids: ['p1', 'p2', 'p3'] }]));
        
        const cursorUpdate = mockEnv.statements.find((s: any) => s.q.includes('community_signal_generation_state'));
        expect(cursorUpdate.args[1]).toBe('1002|p3');
    });
});
