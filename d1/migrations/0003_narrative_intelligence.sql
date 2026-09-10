-- Migration: 0003_narrative_intelligence.sql
-- Description: Narrative evolution deltas and cross-source claim comparison storage for Phase 10

-- ─── Event Narrative Deltas (What Changed between Version N-1 and N) ──────────
CREATE TABLE IF NOT EXISTS event_narrative_deltas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  previous_version INTEGER NOT NULL,
  current_version INTEGER NOT NULL,
  content TEXT NOT NULL,
  article_fingerprint TEXT NOT NULL,
  model TEXT DEFAULT 'gemini-3.6-flash',
  status TEXT DEFAULT 'completed',
  error_message TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(event_id, previous_version, current_version)
);

CREATE INDEX IF NOT EXISTS idx_event_narrative_deltas_event ON event_narrative_deltas(event_id, current_version DESC);
CREATE INDEX IF NOT EXISTS idx_event_narrative_deltas_fingerprint ON event_narrative_deltas(event_id, article_fingerprint);

-- ─── Event Claim Comparisons (Cross-Source Consensus / Disagreement) ─────────
CREATE TABLE IF NOT EXISTS event_claim_comparisons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  content TEXT NOT NULL,
  article_fingerprint TEXT NOT NULL,
  model TEXT DEFAULT 'gemini-3.6-flash',
  status TEXT DEFAULT 'completed',
  error_message TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(event_id, version)
);

CREATE INDEX IF NOT EXISTS idx_event_claim_comp_event_version ON event_claim_comparisons(event_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_event_claim_comp_fingerprint ON event_claim_comparisons(event_id, article_fingerprint);
