-- Migration: 0008_community_intelligence.sql

CREATE TABLE IF NOT EXISTS community_metrics_snapshots (
  event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  lifetime_posts INTEGER NOT NULL DEFAULT 0,
  lifetime_participants INTEGER NOT NULL DEFAULT 0,
  posts_last_24h INTEGER NOT NULL DEFAULT 0,
  participants_last_24h INTEGER NOT NULL DEFAULT 0,
  momentum_score REAL NOT NULL DEFAULT 0.0,
  last_computed_at INTEGER NOT NULL DEFAULT (unixepoch())
);
