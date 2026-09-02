/**
 * Shared types for AI News Intelligence Workers — Phase 0 (Canonical)
 */

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  HMAC_SECRET: string;
  GEMINI_API_KEY: string;
  PIPELINE_TOKEN_ID: string;
  ENVIRONMENT: string;
  CORS_ORIGIN: string;
  PUBLIC_RATE_LIMIT_WINDOW_SECONDS: string;
  PUBLIC_RATE_LIMIT_MAX_REQUESTS: string;
  INTERNAL_RATE_LIMIT_WINDOW_SECONDS: string;
  INTERNAL_RATE_LIMIT_MAX_REQUESTS: string;
  PUBLIC_BODY_LIMIT_BYTES: string;
  INTERNAL_BODY_LIMIT_BYTES: string;
  HMAC_ALGORITHM: string;
  HMAC_HEADER: string;
  NONCE_HEADER: string;
  TIMESTAMP_HEADER: string;
  REPLAY_WINDOW_SECONDS: string;
}

// ─── Entities ──────────────────────────────────────────────

export interface Source {
  id: number;
  name: string;
  feed_url: string | null;
  base_url: string;
  source_type: string;
  reliability_score: number;
  fetch_interval_minutes: number;
  active: number;
  last_fetched_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ArticleRaw {
  id: number;
  external_id: string;
  source_id: number;
  title: string;
  summary: string | null;
  url: string;
  raw_content: string | null;
  published_at: number | null;
  fetched_at: number;
  language: string;
  status: string;
  created_at: number;
}

export interface ArticleContent {
  id: number;
  article_raw_id: number;
  cleaned_text: string | null;
  extracted_entities: string | null;
  readability_score: number | null;
  word_count: number | null;
  processed_at: number;
}

export interface Event {
  id: number;
  event_hash: string;
  title: string;
  description: string | null;
  severity: string;
  started_at: number | null;
  ended_at: number | null;
  status: string;
  created_at: number;
}

export interface ArticleEvent {
  article_raw_id: number;
  event_id: number;
  relevance_score: number;
}

export interface Topic {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  parent_id: number | null;
  active: number;
  created_at: number;
}

export interface ArticleTopic {
  article_raw_id: number;
  topic_id: number;
  confidence: number;
}

export interface PipelineJob {
  id: number;
  job_type: string;
  status: string;
  payload: string | null;
  result: string | null;
  error_message: string | null;
  started_at: number | null;
  completed_at: number | null;
  retry_count: number;
  created_at: number;
}

export interface AiJob {
  id: number;
  article_raw_id: number | null;
  job_type: string;
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  status: string;
  result: string | null;
  error_message: string | null;
  started_at: number | null;
  completed_at: number | null;
  created_at: number;
}

export interface AiLog {
  id: number;
  ai_job_id: number | null;
  log_level: string;
  message: string;
  metadata: string | null;
  created_at: number;
}

export interface DedupHash {
  id: number;
  hash: string;
  article_raw_id: number | null;
  hash_type: string;
  created_at: number;
}

export interface SourceHealth {
  id: number;
  source_id: number;
  status: string;
  last_success_at: number | null;
  last_failure_at: number | null;
  consecutive_failures: number;
  error_message: string | null;
  response_time_ms: number | null;
  checked_at: number;
}

export interface AnalyticsDaily {
  id: number;
  date: string;
  articles_fetched: number;
  articles_processed: number;
  articles_published: number;
  api_requests: number;
  errors: number;
  avg_response_time_ms: number | null;
  created_at: number;
}

export interface UserPreference {
  id: number;
  user_id: string;
  preferred_topics: string | null;
  preferred_sources: string | null;
  digest_frequency: string;
  email: string | null;
  created_at: number;
  updated_at: number;
}

export interface SavedArticle {
  id: number;
  user_id: string;
  article_raw_id: number;
  note: string | null;
  created_at: number;
}

export interface HiddenStory {
  id: number;
  user_id: string;
  article_raw_id: number;
  reason: string;
  created_at: number;
}

export interface NewsletterQueue {
  id: number;
  user_id: string;
  article_raw_id: number;
  sent: number;
  sent_at: number | null;
  created_at: number;
}

export interface PipelineToken {
  id: number;
  token_id: string;
  token_secret_hash: string;
  name: string;
  scopes: string;
  active: number;
  created_at: number;
  expires_at: number | null;
}

// ─── API Types ─────────────────────────────────────────────

export interface ArticleExtractedEntities {
  topics?: string[];
  events?: {
    title: string;
    description: string;
    severity: string;
  }[];
}

export interface FeedItem {
  id: number;
  external_id: string;
  title: string;
  summary: string | null;
  url: string;
  source: string;
  published_at: number | null;
  category: string | null;
  topics: string[];
  events: { title: string; hash: string }[];
  extracted_entities?: ArticleExtractedEntities;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
  };
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

export interface EventSummary {
  hash: string;
  title: string;
  description: string | null;
  severity: string;
  started_at: number | null;
  article_count: number;
}
