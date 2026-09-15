-- Migration 0009: Community Signals Foundation

CREATE TABLE IF NOT EXISTS community_signals (
    id TEXT PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('emerging_theme', 'common_question', 'divergent_view', 'repeated_observation')),
    status TEXT NOT NULL CHECK(status IN ('candidate', 'approved', 'rejected', 'stale', 'invalidated')),
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_community_signals_event_status ON community_signals(event_id, status);

CREATE TABLE IF NOT EXISTS community_signal_evidence (
    signal_id TEXT NOT NULL REFERENCES community_signals(id) ON DELETE CASCADE,
    post_id TEXT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
    added_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (signal_id, post_id)
);

CREATE TABLE IF NOT EXISTS community_signal_reviews (
    id TEXT PRIMARY KEY,
    signal_id TEXT NOT NULL REFERENCES community_signals(id) ON DELETE CASCADE,
    reviewer_id TEXT NOT NULL,
    previous_status TEXT NOT NULL,
    new_status TEXT NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS community_signal_generation_state (
    event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
    last_processed_post_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
