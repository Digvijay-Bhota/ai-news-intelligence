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
  created_at INTEGER DEFAULT (unixepoch())
);

-- ─── Article Content (processed / enriched) ────────────────
CREATE TABLE IF NOT EXISTS article_content (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_raw_id INTEGER NOT NULL REFERENCES articles_raw(id) ON DELETE CASCADE,
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
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
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
