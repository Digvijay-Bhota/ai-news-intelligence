import { describe, it, expect } from 'vitest';
import { 
    persistCandidateWithCursorAndEvidence, 
    transitionSignalState,
    getGenerationCursor,
    advanceCursor
} from '../src/db/community-signals';

describe('Community Signals DB', () => {
    // mock DB factory
    function createMockDB(posts: any[]) {
        let executedStatements: any[] = [];
        return {
            executedStatements,
            prepare: (q: string) => {
                let currentBinds: any[] = [];
                return {
                    bind: (...args: any[]) => {
                        currentBinds = args;
                        return {
                            all: async () => {
                                if (q.includes('SELECT id FROM community_posts')) {
                                    const eventId = currentBinds[currentBinds.length - 1];
                                    const ids = currentBinds.slice(0, currentBinds.length - 1);
                                    const res = posts.filter(p => ids.includes(p.id) && p.event_id === eventId && p.status === 'active');
                                    return { results: res };
                                }
                                if (q.includes('SELECT e.post_id')) {
                                    return { results: [] };
                                }
                                return { results: [] };
                            },
                            first: async () => {
                                if (q.includes('SELECT * FROM community_signals WHERE id')) {
                                    return { id: currentBinds[0], event_id: currentBinds[1], status: 'candidate' };
                                }
                                if (q.includes('community_signal_generation_state')) {
                                    return { event_id: currentBinds[0], last_processed_post_id: 'post_0' };
                                }
                                return null;
                            },
                            run: async () => {
                                executedStatements.push({ q, args: currentBinds });
                                return { success: true };
                            },
                            statement: { q, currentBinds }
                        }
                    }
                }
            },
            batch: async (statements: any[]) => {
                for (const st of statements) {
                    executedStatements.push({ q: st.statement.q, args: st.statement.currentBinds });
                }
                return { success: true };
            }
        } as any;
    }

    it('event isolation: prevents attaching cross-event evidence', async () => {
        const posts = [
            { id: 'p1', event_id: 1, status: 'active' },
            { id: 'p2', event_id: 2, status: 'active' }
        ];
        const db = createMockDB(posts);
        await expect(persistCandidateWithCursorAndEvidence(db, 1, 'emerging_theme', 'text', ['p1', 'p2'], 'p2'))
            .rejects.toThrow('One or more post IDs are invalid, not active, or do not belong to the event');
    });

    it('evidence uniqueness & cursor advancement', async () => {
        const posts = [
            { id: 'p1', event_id: 1, status: 'active' }
        ];
        const db = createMockDB(posts);
        await persistCandidateWithCursorAndEvidence(db, 1, 'emerging_theme', 'text', ['p1'], 'p1');
        
        const evidenceInsert = db.executedStatements.find((s: any) => s.q.includes('community_signal_evidence'));
        expect(evidenceInsert).toBeDefined();
        
        const cursorAdv = db.executedStatements.find((s: any) => s.q.includes('community_signal_generation_state'));
        expect(cursorAdv.args).toEqual([1, 'p1', expect.any(Number)]);
    });

    it('cursor does not advance on failed transaction', async () => {
        const posts: any[] = []; // Invalid, so validation will fail
        const db = createMockDB(posts);
        await expect(persistCandidateWithCursorAndEvidence(db, 1, 'emerging_theme', 'text', ['p1'], 'p1'))
            .rejects.toThrow();
        expect(db.executedStatements.length).toBe(0);
    });

    it('allowed state transitions and append-only review behavior', async () => {
        const db = createMockDB([]);
        await transitionSignalState(db, 1, 'sig_1', 'approved', 'user_1', 'reason');
        
        const updateSig = db.executedStatements.find((s: any) => s.q.includes('UPDATE community_signals'));
        expect(updateSig.args[0]).toBe('approved');
        
        const insertRev = db.executedStatements.find((s: any) => s.q.includes('INSERT INTO community_signal_reviews'));
        expect(insertRev.args[2]).toBe('user_1');
        expect(insertRev.args[3]).toBe('candidate');
        expect(insertRev.args[4]).toBe('approved');
    });

    it('forbidden state transitions', async () => {
        const db = createMockDB([]); 
        await expect(transitionSignalState(db, 1, 'sig_1', 'stale', 'user_1'))
            .rejects.toThrow('Forbidden transition from candidate to stale');
    });

    it('one cursor exists per event (ON CONFLICT)', async () => {
        const db = createMockDB([]);
        await advanceCursor(db, 1, 'p99');
        const q = db.executedStatements.find((s: any) => s.q.includes('ON CONFLICT(event_id) DO UPDATE SET last_processed_post_id'));
        expect(q).toBeDefined();
    });
    
    it('cursor resumes correctly after restart', async () => {
        const db = createMockDB([]);
        const cursor = await getGenerationCursor(db, 1);
        expect(cursor?.last_processed_post_id).toBe('post_0');
    });
});
