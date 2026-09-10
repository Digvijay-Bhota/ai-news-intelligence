-- Migration: 0004_user_identity_and_follows.sql
-- Description: Phase 11A Durable anonymous user identities and follow graph

-- ─── Users (Durable Anonymous Identity) ──────────────────────
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_active_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ─── User Follows (Topic, Event, Source Follow Graph) ─────────
CREATE TABLE IF NOT EXISTS user_follows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL, -- 'topic', 'event', 'source'
  target_id TEXT NOT NULL,   -- canonical slug, event_hash, or source name
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_user_follows_user ON user_follows(user_id, target_type);
CREATE INDEX IF NOT EXISTS idx_user_follows_target ON user_follows(target_type, target_id);
