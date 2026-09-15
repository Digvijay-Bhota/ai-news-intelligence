-- D1 Schema for AI News Intelligence — Phase 0 (Canonical)
-- SQLite-compatible, supports the full pipeline model

PRAGMA foreign_keys = ON;

-- ─── Sources ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  feed_url TEXT,
  base_url TEXT NOT NULL,
  source_type TEXT DEFAULT 'rss', -- rss, api, scrape
  reliability_score REAL DEFAULT 0.5,
  fetch_interval_minutes INTEGER DEFAULT 60,
  active INTEGER DEFAULT 1,
  last_fetched_at INTEGER,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

-- ─── Raw Articles (ingested from sources) ──────────────────
CREATE TABLE IF NOT EXISTS articles_raw (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT UNIQUE NOT NULL,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  title TEXT NOT NULL,
  summary TEXT,
  url TEXT NOT NULL,
  raw_content TEXT,
  published_at INTEGER,
  fetched_at INTEGER DEFAULT (unixepoch()),
  language TEXT DEFAULT 'en',
  status TEXT DEFAULT 'pending', -- pending, processed, failed
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

-- ─── Article Content (processed / enriched) ────────────────
CREATE TABLE IF NOT EXISTS article_content (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_raw_id INTEGER NOT NULL UNIQUE REFERENCES articles_raw(id) ON DELETE CASCADE,
  cleaned_text TEXT,
  extracted_entities TEXT, -- JSON
  readability_score REAL,
  word_count INTEGER,
  processed_at INTEGER DEFAULT (unixepoch())
);

-- ─── Events (detected from articles) ───────────────────────
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_hash TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  severity TEXT DEFAULT 'info', -- info, warning, critical
  started_at INTEGER,
  ended_at INTEGER,
  status TEXT DEFAULT 'active', -- active, resolved, false_positive
  created_at INTEGER DEFAULT (unixepoch())
);

-- ─── Article-Events Junction ───────────────────────────────
CREATE TABLE IF NOT EXISTS article_events (
  article_raw_id INTEGER NOT NULL REFERENCES articles_raw(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  relevance_score REAL DEFAULT 1.0,
  PRIMARY KEY (article_raw_id, event_id)
);

-- ─── Event Briefs (Grounded AI Summaries) ──────────────────
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
  status TEXT DEFAULT 'completed', -- generating, completed, failed
  error_message TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(event_id, article_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_event_briefs_event_version ON event_briefs(event_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_event_briefs_event_fingerprint ON event_briefs(event_id, article_fingerprint);

-- ─── Event Narrative Deltas (Phase 10: What Changed) ───────
CREATE TABLE IF NOT EXISTS event_narrative_deltas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  previous_version INTEGER NOT NULL,
  current_version INTEGER NOT NULL,
  content TEXT NOT NULL,
  article_fingerprint TEXT NOT NULL,
  model TEXT DEFAULT 'gemini-3.6-flash',
  status TEXT DEFAULT 'completed', -- generating, completed, failed
  error_message TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(event_id, previous_version, current_version)
);

CREATE INDEX IF NOT EXISTS idx_event_narrative_deltas_event ON event_narrative_deltas(event_id, current_version DESC);
CREATE INDEX IF NOT EXISTS idx_event_narrative_deltas_fingerprint ON event_narrative_deltas(event_id, article_fingerprint);

-- ─── Event Claim Comparisons (Phase 10: Cross-Source) ──────
CREATE TABLE IF NOT EXISTS event_claim_comparisons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  content TEXT NOT NULL,
  article_fingerprint TEXT NOT NULL,
  model TEXT DEFAULT 'gemini-3.6-flash',
  status TEXT DEFAULT 'completed', -- generating, completed, failed
  error_message TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(event_id, version)
);

CREATE INDEX IF NOT EXISTS idx_event_claim_comp_event_version ON event_claim_comparisons(event_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_event_claim_comp_fingerprint ON event_claim_comparisons(event_id, article_fingerprint);


-- ─── Topics ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  parent_id INTEGER REFERENCES topics(id),
  active INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch())
);

-- ─── Article-Topics Junction ───────────────────────────────
CREATE TABLE IF NOT EXISTS article_topics (
  article_raw_id INTEGER NOT NULL REFERENCES articles_raw(id) ON DELETE CASCADE,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  confidence REAL DEFAULT 1.0,
  PRIMARY KEY (article_raw_id, topic_id)
);

-- ─── Pipeline Jobs ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pipeline_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_type TEXT NOT NULL, -- fetch, parse, dedup, enrich, publish
  status TEXT DEFAULT 'queued', -- queued, running, completed, failed
  payload TEXT, -- JSON
  result TEXT, -- JSON
  error_message TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  retry_count INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch())
);

-- ─── AI Jobs ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_raw_id INTEGER REFERENCES articles_raw(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL, -- summarize, classify, sentiment, extract_entities
  model TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  status TEXT DEFAULT 'queued',
  result TEXT, -- JSON
  error_message TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER DEFAULT (unixepoch())
);

-- ─── AI Logs ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ai_job_id INTEGER REFERENCES ai_jobs(id) ON DELETE CASCADE,
  log_level TEXT DEFAULT 'info', -- debug, info, warning, error
  message TEXT NOT NULL,
  metadata TEXT, -- JSON
  created_at INTEGER DEFAULT (unixepoch())
);

-- ─── Deduplication Hashes ──────────────────────────────────
CREATE TABLE IF NOT EXISTS dedup_hashes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT UNIQUE NOT NULL,
  article_raw_id INTEGER REFERENCES articles_raw(id) ON DELETE CASCADE,
  hash_type TEXT DEFAULT 'content', -- content, title, url
  created_at INTEGER DEFAULT (unixepoch())
);

-- ─── Source Health ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS source_health (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL UNIQUE REFERENCES sources(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'healthy', -- healthy, degraded, down
  last_success_at INTEGER,
  last_failure_at INTEGER,
  consecutive_failures INTEGER DEFAULT 0,
  error_message TEXT,
  response_time_ms INTEGER,
  checked_at INTEGER DEFAULT (unixepoch())
);

-- ─── Analytics Daily ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS analytics_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT UNIQUE NOT NULL, -- YYYY-MM-DD
  articles_fetched INTEGER DEFAULT 0,
  articles_processed INTEGER DEFAULT 0,
  articles_published INTEGER DEFAULT 0,
  api_requests INTEGER DEFAULT 0,
  errors INTEGER DEFAULT 0,
  avg_response_time_ms INTEGER,
  created_at INTEGER DEFAULT (unixepoch())
);

-- ─── Users (Durable Anonymous Identity — Phase 11A/11C) ──────
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_active_at INTEGER NOT NULL DEFAULT (unixepoch()),
  acknowledged_through INTEGER NOT NULL DEFAULT 0
);

-- ─── Community Identity (Phase 13A) ────────────────────────
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  public_id TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

-- ─── User Event Reads (Since-Last-Seen Read State — Phase 11C) ─
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

CREATE INDEX IF NOT EXISTS idx_user_event_reads_user ON user_event_reads(user_id, read_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_event_reads_event ON user_event_reads(event_id);

-- ─── User Follows (Topic, Event, Source — Phase 11A) ────────
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

-- ─── User Preferences ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT UNIQUE NOT NULL,
  preferred_topics TEXT, -- JSON array of topic slugs
  preferred_sources TEXT, -- JSON array of source names
  digest_frequency TEXT DEFAULT 'daily', -- realtime, daily, weekly, none
  email TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

-- ─── Saved Articles ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS saved_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  article_raw_id INTEGER NOT NULL REFERENCES articles_raw(id) ON DELETE CASCADE,
  note TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(user_id, article_raw_id)
);

-- ─── Hidden Stories ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hidden_stories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  article_raw_id INTEGER NOT NULL REFERENCES articles_raw(id) ON DELETE CASCADE,
  reason TEXT DEFAULT 'user_hidden',
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(user_id, article_raw_id)
);

-- ─── Newsletter Queue ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS newsletter_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  article_raw_id INTEGER NOT NULL REFERENCES articles_raw(id) ON DELETE CASCADE,
  sent INTEGER DEFAULT 0,
  sent_at INTEGER,
  created_at INTEGER DEFAULT (unixepoch())
);

-- ─── Pipeline Tokens (simple auth for internal API) ────────
CREATE TABLE IF NOT EXISTS pipeline_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id TEXT UNIQUE NOT NULL,
  token_secret_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  scopes TEXT DEFAULT 'internal', -- internal, admin
  active INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch()),
  expires_at INTEGER
);

-- ─── Rate Limit Logs ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS rate_limit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identifier TEXT NOT NULL, -- IP (public) or token_id (internal)
  endpoint TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch())
);

-- ─── Request Logs (for replay protection) ──────────────────
CREATE TABLE IF NOT EXISTS request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nonce TEXT UNIQUE NOT NULL,
  identifier TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
);

-- ─── Indexes ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_articles_raw_external_id ON articles_raw(external_id);
CREATE INDEX IF NOT EXISTS idx_articles_raw_source ON articles_raw(source_id);
CREATE INDEX IF NOT EXISTS idx_articles_raw_status ON articles_raw(status);
CREATE INDEX IF NOT EXISTS idx_articles_raw_published_at ON articles_raw(published_at);
CREATE INDEX IF NOT EXISTS idx_events_hash ON events(event_hash);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
CREATE INDEX IF NOT EXISTS idx_article_events_event_id ON article_events(event_id);
CREATE INDEX IF NOT EXISTS idx_dedup_hashes_hash ON dedup_hashes(hash);
CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_status ON pipeline_jobs(status);
CREATE INDEX IF NOT EXISTS idx_ai_jobs_status ON ai_jobs(status);
CREATE INDEX IF NOT EXISTS idx_source_health_source ON source_health(source_id);
CREATE INDEX IF NOT EXISTS idx_analytics_daily_date ON analytics_daily(date);
CREATE INDEX IF NOT EXISTS idx_user_preferences_user ON user_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_saved_articles_user ON saved_articles(user_id);
CREATE INDEX IF NOT EXISTS idx_hidden_stories_user ON hidden_stories(user_id);
CREATE INDEX IF NOT EXISTS idx_rate_limit_id_window ON rate_limit_logs(identifier, window_start);
CREATE INDEX IF NOT EXISTS idx_request_logs_nonce ON request_logs(nonce);

-- Seed data
INSERT OR IGNORE INTO sources (name, base_url, source_type, active) VALUES
  ('TechCrunch', 'https://techcrunch.com', 'rss', 1),
  ('The Verge', 'https://theverge.com', 'rss', 1),
  ('Ars Technica', 'https://arstechnica.com', 'rss', 1);

INSERT OR IGNORE INTO topics (name, slug, description) VALUES
  ('Artificial Intelligence', 'artificial-intelligence', 'AI and machine learning news'),
  ('Cybersecurity', 'cybersecurity', 'Security breaches, threats, and defenses'),
  ('Cloud Computing', 'cloud-computing', 'AWS, Azure, GCP, and cloud infrastructure'),
  ('Hardware', 'hardware', 'CPUs, GPUs, and consumer electronics');

-- M7-D Topic Filters
CREATE INDEX IF NOT EXISTS idx_topics_slug ON topics(slug);
CREATE INDEX IF NOT EXISTS idx_article_topics_topic ON article_topics(topic_id);

-- ─── Community Discussion (Phase 13B) ──────────────────────
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

CREATE TABLE IF NOT EXISTS community_votes (
  post_id TEXT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vote_type TEXT DEFAULT 'upvote',
  created_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS community_reports (
  post_id TEXT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (post_id, user_id)
);

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
