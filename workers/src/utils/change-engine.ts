/**
 * change-engine.ts — Phase 11C: Since-Last-Seen Intelligence Engine
 *
 * Provides a pure, deterministic change detection and delta classification engine.
 * Computes canonical EventChangeCursor and classifies event delta state according
 * to strict server-authoritative precedence.
 */

import type { SinceLastSeenInfo, UserEventRead } from '../types';

export interface EventCursorInput {
  last_published_at?: number | null;
  started_at?: number | null;
  created_at?: number | null;
  brief_updated_at?: number | null;
  delta_created_at?: number | null;
  claim_created_at?: number | null;
}

/**
 * Computes the single canonical EventChangeCursor across the platform.
 * Used identically for:
 * 1. Catch-up candidate ordering (ORDER BY event_change_cursor DESC)
 * 2. last_changed_at
 * 3. Catch-up feed ordering
 * 4. Deterministic pagination
 * 5. Change detection
 */
export function computeEventChangeCursor(event: EventCursorInput): number {
  return Math.max(
    event.last_published_at ?? 0,
    event.started_at ?? 0,
    event.created_at ?? 0,
    event.brief_updated_at ?? 0,
    event.delta_created_at ?? 0,
    event.claim_created_at ?? 0
  );
}

export interface EventDeltaEvaluationInput {
  started_at: number | null;
  created_at: number | null;
  last_published_at: number | null;
  article_count: number;
  source_count: number;
  brief_version: number;
  brief_updated_at: number | null;
  delta_created_at: number | null;
  claim_version: number;
  claim_created_at: number | null;
  acknowledged_through: number;
  articles_before_ack: number;
  user_read: UserEventRead | null;
}

/**
 * Pure, deterministic delta evaluator according to Phase 11C approved design.
 *
 * Precedence:
 * 1. NEW_EVENT: event.started_at > acknowledged_through AND no user_event_reads row
 * 2. NARRATIVE_EVOLVED: completed brief exists AND brief version > seen_brief_version AND brief.updated_at > acknowledged_through
 * 3. CROSS_SOURCE_PERSPECTIVE: completed claim comparison exists AND claim version > seen_claim_version AND claim.created_at > acknowledged_through AND source_count >= 2
 * 4. NEW_REPORTING: new_article_count > 0 AND last_published_at > acknowledged_through
 * 5. NO_CHANGE
 */
export function evaluateEventDelta(input: EventDeltaEvaluationInput): SinceLastSeenInfo {
  const {
    started_at,
    created_at,
    last_published_at,
    article_count,
    source_count,
    brief_version,
    brief_updated_at,
    delta_created_at,
    claim_version,
    claim_created_at,
    acknowledged_through,
    articles_before_ack,
    user_read,
  } = input;

  const eventChangeCursor = computeEventChangeCursor({
    last_published_at,
    started_at,
    created_at,
    brief_updated_at,
    delta_created_at,
    claim_created_at,
  });

  // Effective event origin timestamp
  const eventStart = started_at ?? created_at ?? 0;

  // Article delta arithmetic:
  // baseline_article_count = max(seen_article_count, articles_before_ack) when user_event_reads exists,
  // otherwise: articles_before_ack
  const baselineArticleCount = user_read
    ? Math.max(user_read.seen_article_count, articles_before_ack)
    : articles_before_ack;
  const newArticleCount = Math.max(0, article_count - baselineArticleCount);

  // 1. NEW_EVENT:
  // event.started_at > acknowledged_through AND no user_event_reads row
  if (eventStart > acknowledged_through && !user_read) {
    return {
      change_type: 'NEW_EVENT',
      is_new: true,
      has_updates: false,
      new_article_count: article_count,
      change_summary: 'New event detected',
      last_changed_at: eventChangeCursor > 0 ? eventChangeCursor : null,
    };
  }

  // 2. NARRATIVE_EVOLVED:
  // completed brief exists AND brief version > seen_brief_version AND brief.updated_at > acknowledged_through
  const seenBriefVersion = user_read ? user_read.seen_brief_version : 1;
  if (
    brief_version > seenBriefVersion &&
    (brief_updated_at ?? 0) > acknowledged_through
  ) {
    const summary =
      newArticleCount > 0
        ? `Narrative evolved to Version ${brief_version} with ${newArticleCount} new report${newArticleCount > 1 ? 's' : ''}`
        : `Narrative evolved to Version ${brief_version}`;
    return {
      change_type: 'NARRATIVE_EVOLVED',
      is_new: false,
      has_updates: true,
      new_article_count: newArticleCount,
      change_summary: summary,
      last_changed_at: eventChangeCursor > 0 ? eventChangeCursor : null,
    };
  }

  // 3. CROSS_SOURCE_PERSPECTIVE:
  // completed claim comparison exists AND claim version > seen_claim_version AND claim.created_at > acknowledged_through AND source_count >= 2
  const seenClaimVersion = user_read ? user_read.seen_claim_version : 0;
  if (
    claim_version > seenClaimVersion &&
    (claim_created_at ?? 0) > acknowledged_through &&
    source_count >= 2
  ) {
    return {
      change_type: 'CROSS_SOURCE_PERSPECTIVE',
      is_new: false,
      has_updates: true,
      new_article_count: newArticleCount,
      change_summary: `New perspectives analyzed across ${source_count} sources`,
      last_changed_at: eventChangeCursor > 0 ? eventChangeCursor : null,
    };
  }

  // 4. NEW_REPORTING:
  // new_article_count > 0 AND last_published_at > acknowledged_through
  if (newArticleCount > 0 && (last_published_at ?? 0) > acknowledged_through) {
    return {
      change_type: 'NEW_REPORTING',
      is_new: false,
      has_updates: true,
      new_article_count: newArticleCount,
      change_summary: `${newArticleCount} new report${newArticleCount > 1 ? 's' : ''} added`,
      last_changed_at: eventChangeCursor > 0 ? eventChangeCursor : null,
    };
  }

  // 5. NO_CHANGE
  return {
    change_type: null,
    is_new: false,
    has_updates: false,
    new_article_count: 0,
    change_summary: null,
    last_changed_at: eventChangeCursor > 0 ? eventChangeCursor : null,
  };
}
