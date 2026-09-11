-- Migration: 0005_since_last_seen.sql
-- Description: Phase 11C Server-authoritative since-last-seen state tracking

ALTER TABLE users
ADD COLUMN acknowledged_through INTEGER NOT NULL DEFAULT 0;

UPDATE users
SET acknowledged_through = unixepoch()
WHERE acknowledged_through = 0;

CREATE TABLE IF NOT EXISTS user_event_reads (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  read_at INTEGER NOT NULL DEFAULT (unixepoch()),
  seen_article_count INTEGER NOT NULL DEFAULT 1,
  seen_brief_version INTEGER NOT NULL DEFAULT 1,
  seen_narrative_version INTEGER NOT NULL DEFAULT 0,
  seen_claim_version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, event_id)
);

CREATE INDEX IF NOT EXISTS
idx_user_event_reads_user
ON user_event_reads(user_id, read_at DESC);

CREATE INDEX IF NOT EXISTS
idx_user_event_reads_event
ON user_event_reads(event_id);
