import type { D1Database } from '@cloudflare/workers-types';

export type SignalType = 'emerging_theme' | 'common_question' | 'divergent_view';
export type SignalStatus = 'candidate' | 'approved' | 'rejected' | 'stale' | 'invalidated';

export interface CommunitySignal {
  id: string;
  event_id: number;
  type: SignalType;
  status: SignalStatus;
  content: string;
  created_at: number;
  updated_at: number;
}

export interface GenerationState {
  event_id: number;
  last_processed_post_id: string;
  updated_at: number;
}

export async function getGenerationCursor(db: D1Database, eventId: number): Promise<GenerationState | null> {
  return await db.prepare(`SELECT * FROM community_signal_generation_state WHERE event_id = ?`)
    .bind(eventId)
    .first<GenerationState>();
}

// Critical Transactional Rule:
// LLM proposal -> application validation -> transaction(candidate/evidence persistence + cursor advancement)
export async function persistCandidateWithCursorAndEvidence(
  db: D1Database,
  eventId: number,
  type: SignalType,
  content: string,
  postIds: string[],
  lastProcessedPostId: string
): Promise<string> {
  const signalId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  
  // Validation: ensure postIds belong to the same eventId
  if (postIds.length === 0) {
      throw new Error('Evidence is required');
  }
  
  const placeholders = postIds.map(() => '?').join(',');
  const validPosts = await db.prepare(
      `SELECT id FROM community_posts WHERE id IN (${placeholders}) AND event_id = ? AND status = 'active'`
  ).bind(...postIds, eventId).all<{id: string}>();
  
  if (validPosts.results.length !== postIds.length) {
      throw new Error('One or more post IDs are invalid, not active, or do not belong to the event');
  }

  const statements = [];
  
  // 1. Candidate persistence
  statements.push(
      db.prepare(`INSERT INTO community_signals (id, event_id, type, status, content, created_at, updated_at) VALUES (?, ?, ?, 'candidate', ?, ?, ?)`)
      .bind(signalId, eventId, type, content, now, now)
  );
  
  // 2. Evidence persistence
  for (const postId of postIds) {
      statements.push(
          db.prepare(`INSERT INTO community_signal_evidence (signal_id, post_id, added_at) VALUES (?, ?, ?)`)
          .bind(signalId, postId, now)
      );
  }
  
  // 3. Generation cursor advancement
  statements.push(
      db.prepare(`INSERT INTO community_signal_generation_state (event_id, last_processed_post_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(event_id) DO UPDATE SET last_processed_post_id = excluded.last_processed_post_id, updated_at = excluded.updated_at`)
      .bind(eventId, lastProcessedPostId, now)
  );

  await db.batch(statements);
  
  return signalId;
}

export async function advanceCursor(db: D1Database, eventId: number, lastProcessedPostId: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await db.prepare(`INSERT INTO community_signal_generation_state (event_id, last_processed_post_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(event_id) DO UPDATE SET last_processed_post_id = excluded.last_processed_post_id, updated_at = excluded.updated_at`)
    .bind(eventId, lastProcessedPostId, now).run();
}

export async function getSignal(db: D1Database, eventId: number, signalId: string): Promise<CommunitySignal | null> {
  return await db.prepare(`SELECT * FROM community_signals WHERE id = ? AND event_id = ?`)
    .bind(signalId, eventId)
    .first<CommunitySignal>();
}

export async function getSignalEvidence(db: D1Database, eventId: number, signalId: string): Promise<{post_id: string}[]> {
  const res = await db.prepare(`
    SELECT e.post_id 
    FROM community_signal_evidence e
    JOIN community_signals s ON s.id = e.signal_id
    WHERE e.signal_id = ? AND s.event_id = ?
  `).bind(signalId, eventId).all<{post_id: string}>();
  return res.results;
}

// State Transition Safety
const ALLOWED_TRANSITIONS: Record<SignalStatus, SignalStatus[]> = {
  candidate: ['approved', 'rejected', 'invalidated'],
  approved: ['stale', 'invalidated'],
  stale: ['invalidated'],
  rejected: [],
  invalidated: []
};

export async function transitionSignalState(
  db: D1Database,
  eventId: number,
  signalId: string,
  newStatus: SignalStatus,
  reviewerId: string,
  reason?: string
): Promise<void> {
  const signal = await getSignal(db, eventId, signalId);
  if (!signal) {
      throw new Error('Signal not found');
  }

  const currentStatus = signal.status;
  if (!ALLOWED_TRANSITIONS[currentStatus].includes(newStatus)) {
      throw new Error(`Forbidden transition from ${currentStatus} to ${newStatus}`);
  }

  if (newStatus === 'rejected' && (!reason || reason.trim() === '')) {
      throw new Error('Rejection requires a non-empty reason');
  }

  const now = Math.floor(Date.now() / 1000);
  const reviewId = crypto.randomUUID();

  const statements = [
      db.prepare(
          `UPDATE community_signals SET status = ?, updated_at = ? WHERE id = ? AND event_id = ? AND status = ?`
      ).bind(newStatus, now, signalId, eventId, currentStatus),
      db.prepare(
          `INSERT INTO community_signal_reviews (id, signal_id, reviewer_id, previous_status, new_status, reason, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT changes() > 0)`
      ).bind(reviewId, signalId, reviewerId, currentStatus, newStatus, reason || null, now)
  ];

  const results = await db.batch(statements);

  if (results[0].meta.changes === 0) {
      throw new Error('Concurrent state transition detected');
  }
}

export async function addEvidenceToSignal(
    db: D1Database,
    eventId: number,
    signalId: string,
    postIds: string[],
    lastProcessedPostId: string
): Promise<void> {
    if (postIds.length === 0) return;
    const now = Math.floor(Date.now() / 1000);

    const signal = await getSignal(db, eventId, signalId);
    if (!signal) throw new Error('Signal not found');

    const placeholders = postIds.map(() => '?').join(',');
    const validPosts = await db.prepare(
        `SELECT id FROM community_posts WHERE id IN (${placeholders}) AND event_id = ? AND status = 'active'`
    ).bind(...postIds, eventId).all<{id: string}>();
    
    if (validPosts.results.length !== postIds.length) {
        throw new Error('One or more post IDs are invalid, not active, or do not belong to the event');
    }

    const statements = [];
    for (const postId of postIds) {
        statements.push(
            db.prepare(`INSERT OR IGNORE INTO community_signal_evidence (signal_id, post_id, added_at) VALUES (?, ?, ?)`)
            .bind(signalId, postId, now)
        );
    }
    
    statements.push(
        db.prepare(`INSERT INTO community_signal_generation_state (event_id, last_processed_post_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(event_id) DO UPDATE SET last_processed_post_id = excluded.last_processed_post_id, updated_at = excluded.updated_at`)
        .bind(eventId, lastProcessedPostId, now)
    );

    await db.batch(statements);
}
