-- Migration: 0002_event_briefs.sql
-- Description: Durable storage for Grounded AI Event Briefs with fingerprinting and provenance

CREATE TABLE IF NOT EXISTS event_briefs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  article_fingerprint TEXT NOT NULL,
  article_ids TEXT NOT NULL,
  source_count INTEGER NOT NULL DEFAULT 0,
  article_count INTEGER NOT NULL DEFAULT 0,
  model TEXT DEFAULT 'gemini-3.6-flash',
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT DEFAULT 'completed',
  error_message TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(event_id, article_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_event_briefs_event_version ON event_briefs(event_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_event_briefs_event_fingerprint ON event_briefs(event_id, article_fingerprint);
