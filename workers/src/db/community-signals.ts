import type { D1Database } from '@cloudflare/workers-types';
import { BadRequestError, ConflictError, NotFoundError } from '../utils/errors';

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
      throw new NotFoundError('Signal not found');
  }

  const currentStatus = signal.status;
  if (!ALLOWED_TRANSITIONS[currentStatus].includes(newStatus)) {
      throw new ConflictError(`Forbidden transition from ${currentStatus} to ${newStatus}`);
  }

  if (newStatus === 'rejected' && (!reason || reason.trim() === '')) {
      throw new BadRequestError('Rejection requires a non-empty reason');
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
      throw new ConflictError('Concurrent state transition detected');
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

export interface CandidateProposal {
    type: SignalType;
    content: string;
    postIds: string[];
}

export interface AppendProposal {
    signalId: string;
    postIds: string[];
}

export async function persistGenerationBatch(
    db: D1Database,
    eventId: number,
    newCandidates: CandidateProposal[],
    appends: AppendProposal[],
    lastProcessedPostId: string
): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const statements = [];

    // Verify all posts exist and are active
    const allPostIds = new Set<string>();
    for (const c of newCandidates) c.postIds.forEach(id => allPostIds.add(id));
    for (const a of appends) a.postIds.forEach(id => allPostIds.add(id));

    const postIdsArr = Array.from(allPostIds);
    if (postIdsArr.length > 0) {
        const placeholders = postIdsArr.map(() => '?').join(',');
        const validPosts = await db.prepare(
            `SELECT id FROM community_posts WHERE id IN (${placeholders}) AND event_id = ? AND status = 'active'`
        ).bind(...postIdsArr, eventId).all<{id: string}>();
        
        if (validPosts.results.length !== postIdsArr.length) {
            throw new Error('One or more post IDs are invalid, not active, or do not belong to the event');
        }
    }

    if (appends.length > 0) {
        const appendSignalIds = Array.from(new Set(appends.map(a => a.signalId)));
        const placeholders = appendSignalIds.map(() => '?').join(',');
        const validSignals = await db.prepare(
            `SELECT id FROM community_signals WHERE id IN (${placeholders}) AND event_id = ? AND status = 'candidate'`
        ).bind(...appendSignalIds, eventId).all<{id: string}>();
        
        if (validSignals.results.length !== appendSignalIds.length) {
            throw new Error('One or more append targets are invalid, not candidate, or do not belong to the event');
        }
    }

    for (const candidate of newCandidates) {
        const signalId = crypto.randomUUID();
        statements.push(
            db.prepare(`INSERT INTO community_signals (id, event_id, type, status, content, created_at, updated_at) VALUES (?, ?, ?, 'candidate', ?, ?, ?)`)
            .bind(signalId, eventId, candidate.type, candidate.content, now, now)
        );
        for (const postId of candidate.postIds) {
            statements.push(
                db.prepare(`INSERT INTO community_signal_evidence (signal_id, post_id, added_at) VALUES (?, ?, ?)`)
                .bind(signalId, postId, now)
            );
        }
    }

    for (const append of appends) {
        for (const postId of append.postIds) {
            statements.push(
                db.prepare(`INSERT OR IGNORE INTO community_signal_evidence (signal_id, post_id, added_at) VALUES (?, ?, ?)`)
                .bind(append.signalId, postId, now)
            );
        }
    }

    statements.push(
        db.prepare(`INSERT INTO community_signal_generation_state (event_id, last_processed_post_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(event_id) DO UPDATE SET last_processed_post_id = excluded.last_processed_post_id, updated_at = excluded.updated_at`)
        .bind(eventId, lastProcessedPostId, now)
    );

    await db.batch(statements);
}

// Candidate review listing (internal operators only)

export const CANDIDATE_LIST_MAX_LIMIT = 50;
const EVIDENCE_PER_CANDIDATE = 10;
const EVIDENCE_BODY_CHARS = 500;
// Same thresholds the public read applies before showing an approved signal.
const PUBLIC_MIN_POSTS = 3;
const PUBLIC_MIN_AUTHORS = 3;

export interface CandidateEvidence {
    post_id: string;
    body: string;
    body_truncated: boolean;
    created_at: number;
}

export interface CandidateSignalSummary {
    id: string;
    type: SignalType;
    content: string;
    created_at: number;
    active_evidence_count: number;
    distinct_author_count: number;
    meets_public_threshold: boolean;
    evidence: CandidateEvidence[];
}

/**
 * Oldest-first candidate signals for one event. Evidence counts and excerpts only
 * include active posts on the same event; author identities are only ever counted.
 */
export async function listCandidateSignals(
    db: D1Database,
    eventId: number,
    limit: number
): Promise<{ candidates: CandidateSignalSummary[]; has_more: boolean }> {
    const rows = (await db.prepare(`
        SELECT s.id, s.type, s.content, s.created_at,
               COUNT(DISTINCT p.id) AS active_evidence_count,
               COUNT(DISTINCT p.user_id) AS distinct_author_count
        FROM community_signals s
        LEFT JOIN community_signal_evidence e ON e.signal_id = s.id
        LEFT JOIN community_posts p ON p.id = e.post_id AND p.event_id = s.event_id AND p.status = 'active'
        WHERE s.event_id = ? AND s.status = 'candidate'
        GROUP BY s.id
        ORDER BY s.created_at ASC, s.id ASC
        LIMIT ?
    `).bind(eventId, limit + 1).all<{
        id: string; type: SignalType; content: string; created_at: number;
        active_evidence_count: number; distinct_author_count: number;
    }>()).results ?? [];

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    if (page.length === 0) return { candidates: [], has_more: false };

    const placeholders = page.map(() => '?').join(',');
    const evidenceRows = (await db.prepare(`
        SELECT signal_id, post_id, body, body_length, created_at FROM (
            SELECT e.signal_id, p.id AS post_id, substr(p.body, 1, ?) AS body, length(p.body) AS body_length,
                   p.created_at,
                   ROW_NUMBER() OVER (PARTITION BY e.signal_id ORDER BY p.created_at ASC, p.id ASC) AS rn
            FROM community_signal_evidence e
            JOIN community_posts p ON p.id = e.post_id
            WHERE e.signal_id IN (${placeholders}) AND p.event_id = ? AND p.status = 'active'
        ) WHERE rn <= ?
        ORDER BY signal_id, created_at ASC, post_id ASC
    `).bind(EVIDENCE_BODY_CHARS, ...page.map(r => r.id), eventId, EVIDENCE_PER_CANDIDATE).all<{
        signal_id: string; post_id: string; body: string; body_length: number; created_at: number;
    }>()).results ?? [];

    const evidenceBySignal = new Map<string, CandidateEvidence[]>();
    for (const r of evidenceRows) {
        const list = evidenceBySignal.get(r.signal_id) ?? [];
        list.push({ post_id: r.post_id, body: r.body, body_truncated: r.body_length > EVIDENCE_BODY_CHARS, created_at: r.created_at });
        evidenceBySignal.set(r.signal_id, list);
    }

    return {
        candidates: page.map(r => ({
            id: r.id,
            type: r.type,
            content: r.content,
            created_at: r.created_at,
            active_evidence_count: r.active_evidence_count,
            distinct_author_count: r.distinct_author_count,
            meets_public_threshold: r.active_evidence_count >= PUBLIC_MIN_POSTS && r.distinct_author_count >= PUBLIC_MIN_AUTHORS,
            evidence: evidenceBySignal.get(r.id) ?? [],
        })),
        has_more: hasMore,
    };
}
