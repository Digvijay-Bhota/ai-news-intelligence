-- Migration: 0007_community_discussion
-- Purpose: Phase 13B Community Discussion Core

-- ─── Community Discussion ──────────────────────────────
CREATE TABLE IF NOT EXISTS community_posts (
  id TEXT PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES community_posts(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  status TEXT DEFAULT 'active', -- active, flagged, hidden, deleted
  context_anchor_type TEXT,
  context_anchor_id TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  edited_at INTEGER,
  edit_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_community_posts_event ON community_posts(event_id, parent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_community_posts_parent ON community_posts(parent_id);

-- ─── Community Votes ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS community_votes (
  post_id TEXT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vote_type TEXT DEFAULT 'upvote',
  created_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (post_id, user_id)
);

-- ─── Community Reports ───────────────────────────────────
CREATE TABLE IF NOT EXISTS community_reports (
  post_id TEXT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (post_id, user_id)
);

-- ─── Moderation Audits ───────────────────────────────────
CREATE TABLE IF NOT EXISTS moderation_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  previous_state TEXT,
  new_state TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);
