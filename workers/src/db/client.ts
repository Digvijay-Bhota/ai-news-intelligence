/**
 * D1 Database Access Layer — Phase 0 (Canonical)
 */

import type { Env, ArticleRaw, Source, Topic, Event, PipelineJob, AiJob, DedupHash, SourceHealth, UserPreference, SavedArticle, HiddenStory, PipelineToken } from '../types';

export class DbClient {
  constructor(private readonly db: D1Database) {}

  // ─── Sources ──────────────────────────────────────────────
  async listSources(): Promise<Source[]> {
    const r = await this.db.prepare('SELECT * FROM sources WHERE active = 1 ORDER BY name').all<Source>();
    return r.results ?? [];
  }

  async getSourceById(id: number): Promise<Source | null> {
    return this.db.prepare('SELECT * FROM sources WHERE id = ?1').bind(id).first<Source>();
  }

  // ─── Articles Raw ─────────────────────────────────────────
  async getArticleById(id: number): Promise<ArticleRaw | null> {
    return this.db.prepare('SELECT * FROM articles_raw WHERE id = ?1').bind(id).first<ArticleRaw>();
  }

  async getArticleByExternalId(externalId: string): Promise<ArticleRaw | null> {
    return this.db.prepare('SELECT * FROM articles_raw WHERE external_id = ?1').bind(externalId).first<ArticleRaw>();
  }

  async listArticles(options: {
    limit?: number;
    offset?: number;
    source_id?: number;
    status?: string;
    orderBy?: 'published_at' | 'created_at';
    order?: 'ASC' | 'DESC';
  } = {}): Promise<{ articles: ArticleRaw[]; total: number }> {
    const { limit = 20, offset = 0, source_id, status, orderBy = 'published_at', order = 'DESC' } = options;

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (source_id !== undefined) { conditions.push('source_id = ?' + (params.length + 1)); params.push(source_id); }
    if (status) { conditions.push('status = ?' + (params.length + 1)); params.push(status); }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countResult = await this.db
      .prepare(`SELECT COUNT(*) as total FROM articles_raw ${where}`)
      .bind(...params)
      .first<{ total: number }>();

    const articles = await this.db
      .prepare(
        `SELECT * FROM articles_raw ${where}
         ORDER BY ${orderBy} ${order}
         LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`
      )
      .bind(...params, limit, offset)
      .all<ArticleRaw>();

    return { articles: articles.results ?? [], total: countResult?.total ?? 0 };
  }

  async createArticle(article: Omit<ArticleRaw, 'id' | 'created_at' | 'fetched_at'>): Promise<ArticleRaw> {
    const now = Math.floor(Date.now() / 1000);
    const result = await this.db
      .prepare(
        `INSERT INTO articles_raw
         (external_id, source_id, title, summary, url, raw_content, published_at, fetched_at, language, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         RETURNING *`
      )
      .bind(
        article.external_id, article.source_id, article.title,
        article.summary ?? null, article.url, article.raw_content ?? null,
        article.published_at ?? null, now, article.language ?? 'en',
        article.status ?? 'pending', now
      )
      .first<ArticleRaw>();

    if (!result) throw new Error('Failed to create article');
    return result;
  }

  async updateArticleStatus(id: number, status: string): Promise<void> {
    await this.db.prepare('UPDATE articles_raw SET status = ?1 WHERE id = ?2').bind(status, id).run();
  }

  // ─── Topics ───────────────────────────────────────────────
  async listTopics(): Promise<Topic[]> {
    const r = await this.db.prepare('SELECT * FROM topics WHERE active = 1 ORDER BY name').all<Topic>();
    return r.results ?? [];
  }

  async getTopicBySlug(slug: string): Promise<Topic | null> {
    return this.db.prepare('SELECT * FROM topics WHERE slug = ?1').bind(slug).first<Topic>();
  }

  // ─── Events ───────────────────────────────────────────────
  async listEvents(options: { status?: string; limit?: number } = {}): Promise<Event[]> {
    const { status, limit = 50 } = options;
    let sql = 'SELECT * FROM events';
    const params: (string | number)[] = [];
    if (status) { sql += ' WHERE status = ?1'; params.push(status); }
    sql += ` ORDER BY created_at DESC LIMIT ?${params.length + 1}`;
    params.push(limit);
    const r = await this.db.prepare(sql).bind(...params).all<Event>();
    return r.results ?? [];
  }

  // ─── Pipeline Jobs ────────────────────────────────────────
  async createPipelineJob(job: Omit<PipelineJob, 'id' | 'created_at' | 'started_at' | 'completed_at' | 'retry_count'> & Partial<Pick<PipelineJob, 'started_at' | 'completed_at' | 'retry_count'>>): Promise<PipelineJob> {
    const now = Math.floor(Date.now() / 1000);
    const startedAt = job.status === 'running' ? now : (job.started_at ?? null);
    const result = await this.db
      .prepare(
        `INSERT INTO pipeline_jobs (job_type, status, payload, created_at, started_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         RETURNING *`
      )
      .bind(job.job_type, job.status ?? 'queued', job.payload ?? null, now, startedAt)
      .first<PipelineJob>();
    if (!result) throw new Error('Failed to create pipeline job');
    return result;
  }

  // ─── AI Jobs ──────────────────────────────────────────────
  async createAiJob(job: Omit<AiJob, 'id' | 'created_at' | 'result' | 'error_message' | 'started_at' | 'completed_at' | 'prompt_tokens' | 'completion_tokens'> & Partial<Pick<AiJob, 'result' | 'error_message' | 'started_at' | 'completed_at' | 'prompt_tokens' | 'completion_tokens'>>): Promise<AiJob> {
    const now = Math.floor(Date.now() / 1000);
    const result = await this.db
      .prepare(
        `INSERT INTO ai_jobs (article_raw_id, job_type, model, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         RETURNING *`
      )
      .bind(job.article_raw_id ?? null, job.job_type, job.model ?? null, job.status ?? 'queued', now)
      .first<AiJob>();
    if (!result) throw new Error('Failed to create AI job');
    return result;
  }

  // ─── AI / Enrichment ──────────────────────────────────────
  async createArticleContent(data: {
    article_raw_id: number;
    cleaned_text: string;
    extracted_entities: string;
  }): Promise<void> {
    await this.db
      .prepare(
        'INSERT INTO article_content (article_raw_id, cleaned_text, extracted_entities) VALUES (?1, ?2, ?3)'
      )
      .bind(data.article_raw_id, data.cleaned_text, data.extracted_entities)
      .run();
  }

  async createTopic(name: string, slug: string): Promise<number> {
    const result = await this.db
      .prepare('INSERT INTO topics (name, slug) VALUES (?1, ?2) RETURNING id')
      .bind(name, slug)
      .first<{ id: number }>();
    if (!result) throw new Error('Failed to create topic');
    return result.id;
  }

  async linkArticleTopic(article_raw_id: number, topic_id: number, confidence: number): Promise<void> {
    await this.db
      .prepare('INSERT INTO article_topics (article_raw_id, topic_id, confidence) VALUES (?1, ?2, ?3)')
      .bind(article_raw_id, topic_id, confidence)
      .run();
  }

  async createEvent(event: Omit<Event, 'id' | 'created_at'>): Promise<number> {
    const result = await this.db
      .prepare(
        'INSERT INTO events (event_hash, title, description, severity, started_at, ended_at, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id'
      )
      .bind(
        event.event_hash,
        event.title,
        event.description,
        event.severity,
        event.started_at,
        event.ended_at,
        event.status
      )
      .first<{ id: number }>();
    if (!result) throw new Error('Failed to create event');
    return result.id;
  }

  async linkArticleEvent(article_raw_id: number, event_id: number, relevance_score: number): Promise<void> {
    await this.db
      .prepare('INSERT INTO article_events (article_raw_id, event_id, relevance_score) VALUES (?1, ?2, ?3)')
      .bind(article_raw_id, event_id, relevance_score)
      .run();
  }

  async getEventByHash(event_hash: string): Promise<Event | null> {
    return this.db.prepare('SELECT * FROM events WHERE event_hash = ?1').bind(event_hash).first<Event>();
  }

  async updateAiJobStatus(id: number, status: string, result?: string, error_message?: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.db
      .prepare(
        'UPDATE ai_jobs SET status = ?1, result = ?2, error_message = ?3, completed_at = ?4 WHERE id = ?5'
      )
      .bind(status, result ?? null, error_message ?? null, now, id)
      .run();
  }

  async createAiLog(ai_job_id: number, message: string, log_level: string = 'info'): Promise<void> {
    await this.db
      .prepare('INSERT INTO ai_logs (ai_job_id, message, log_level) VALUES (?1, ?2, ?3)')
      .bind(ai_job_id, message, log_level)
      .run();
  }

  async claimArticle(id: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        'UPDATE articles_raw SET status = "processing" WHERE id = ?1 AND status = "pending"'
      )
      .bind(id)
      .run();
    return result.meta.changes === 1;
  }

  async claimFailedArticle(id: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        'UPDATE articles_raw SET status = "processing" WHERE id = ?1 AND status = "failed"'
      )
      .bind(id)
      .run();
    return result.meta.changes === 1;
  }

  async listRetryableFailedArticles(limit: number): Promise<ArticleRaw[]> {
    const query = `
      SELECT a.*
      FROM articles_raw a
      WHERE a.status = 'failed'
        AND (
          SELECT COUNT(*)
          FROM ai_jobs j
          WHERE j.article_raw_id = a.id AND j.job_type = 'enrichment'
        ) < IFNULL((
          SELECT CASE
            WHEN latest_failed_job.error_message LIKE '%429%' THEN 5
            ELSE 2
          END
          FROM ai_jobs latest_failed_job
          WHERE latest_failed_job.article_raw_id = a.id
            AND latest_failed_job.job_type = 'enrichment'
            AND latest_failed_job.status = 'failed'
          ORDER BY latest_failed_job.created_at DESC
          LIMIT 1
        ), 2)
      ORDER BY a.created_at ASC
      LIMIT ?1
    `;
    const r = await this.db.prepare(query).bind(limit).all<ArticleRaw>();
    return r.results ?? [];
  }

  async updatePipelineJobStatus(id: number, status: string, error?: string | null): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.db
      .prepare(
        'UPDATE pipeline_jobs SET status = ?1, error_message = ?2, completed_at = ?3 WHERE id = ?4'
      )
      .bind(status, error ?? null, now, id)
      .run();
  }

  async getSourceHealth(source_id: number): Promise<SourceHealth | null> {
    return this.db.prepare('SELECT * FROM source_health WHERE source_id = ?1').bind(source_id).first<SourceHealth>();
  }

  async updateSourceHealth(source_id: number, data: {
    status: string,
    last_success_at?: number | null,
    last_failure_at?: number | null,
    consecutive_failures: number,
    error_message: string | null
  }): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.db
      .prepare(
        'UPDATE source_health SET status = ?1, last_success_at = ?2, last_failure_at = ?3, consecutive_failures = ?4, error_message = ?5, checked_at = ?6 WHERE source_id = ?7'
      )
      .bind(
        data.status,
        data.last_success_at ?? null,
        data.last_failure_at ?? null,
        data.consecutive_failures,
        data.error_message,
        now,
        source_id
      )
      .run();
  }

  // ─── Deduplication ────────────────────────────────────────
  async getDedupHash(hash: string): Promise<DedupHash | null> {
    return this.db.prepare('SELECT * FROM dedup_hashes WHERE hash = ?1').bind(hash).first<DedupHash>();
  }

  async createDedupHash(hash: string, articleRawId: number): Promise<void> {
    await this.db
      .prepare('INSERT INTO dedup_hashes (hash, article_raw_id, hash_type) VALUES (?1, ?2, ?3)')
      .bind(hash, articleRawId, 'content')
      .run();
  }

  // ─── User Preferences ─────────────────────────────────────
  async getUserPreferences(userId: string): Promise<UserPreference | null> {
    return this.db.prepare('SELECT * FROM user_preferences WHERE user_id = ?1').bind(userId).first<UserPreference>();
  }

  async upsertUserPreferences(prefs: Omit<UserPreference, 'id' | 'created_at' | 'updated_at'>): Promise<UserPreference> {
    const now = Math.floor(Date.now() / 1000);
    const existing = await this.getUserPreferences(prefs.user_id);
    if (existing) {
      const result = await this.db
        .prepare(
          `UPDATE user_preferences
           SET preferred_topics = ?1, preferred_sources = ?2, digest_frequency = ?3, email = ?4, updated_at = ?5
           WHERE user_id = ?6
           RETURNING *`
        )
        .bind(prefs.preferred_topics ?? null, prefs.preferred_sources ?? null, prefs.digest_frequency, prefs.email ?? null, now, prefs.user_id)
        .first<UserPreference>();
      if (!result) throw new Error('Failed to update preferences');
      return result;
    }
    const result = await this.db
      .prepare(
        `INSERT INTO user_preferences (user_id, preferred_topics, preferred_sources, digest_frequency, email, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         RETURNING *`
      )
      .bind(prefs.user_id, prefs.preferred_topics ?? null, prefs.preferred_sources ?? null, prefs.digest_frequency, prefs.email ?? null, now, now)
      .first<UserPreference>();
    if (!result) throw new Error('Failed to create preferences');
    return result;
  }

  // ─── Saved Articles ───────────────────────────────────────
  async listSavedArticles(userId: string): Promise<SavedArticle[]> {
    const r = await this.db
      .prepare('SELECT * FROM saved_articles WHERE user_id = ?1 ORDER BY created_at DESC')
      .bind(userId)
      .all<SavedArticle>();
    return r.results ?? [];
  }

  async createSavedArticle(userId: string, articleRawId: number, note?: string): Promise<SavedArticle> {
    const now = Math.floor(Date.now() / 1000);
    const result = await this.db
      .prepare(
        `INSERT INTO saved_articles (user_id, article_raw_id, note, created_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(user_id, article_raw_id) DO UPDATE SET note = excluded.note
         RETURNING *`
      )
      .bind(userId, articleRawId, note ?? null, now)
      .first<SavedArticle>();
    if (!result) throw new Error('Failed to save article');
    return result;
  }

  async deleteSavedArticle(id: number, userId: string): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM saved_articles WHERE id = ?1 AND user_id = ?2')
      .bind(id, userId)
      .run();
    return result.meta.changes > 0;
  }

  // ─── Hidden Stories ───────────────────────────────────────
  async createHiddenStory(userId: string, articleRawId: number, reason?: string): Promise<HiddenStory> {
    const now = Math.floor(Date.now() / 1000);
    const result = await this.db
      .prepare(
        `INSERT INTO hidden_stories (user_id, article_raw_id, reason, created_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(user_id, article_raw_id) DO NOTHING
         RETURNING *`
      )
      .bind(userId, articleRawId, reason ?? 'user_hidden', now)
      .first<HiddenStory>();
    if (!result) throw new Error('Failed to hide story');
    return result;
  }

  // ─── Pipeline Tokens ──────────────────────────────────────
  async getPipelineTokenById(tokenId: string): Promise<PipelineToken | null> {
    return this.db
      .prepare('SELECT * FROM pipeline_tokens WHERE token_id = ?1 AND active = 1')
      .bind(tokenId)
      .first<PipelineToken>();
  }

  // ─── Analytics ────────────────────────────────────────────
  async incrementAnalytics(date: string, field: string): Promise<void> {
    await this.db.prepare(
      `INSERT INTO analytics_daily (date, ${field}, created_at)
       VALUES (?1, 1, ?2)
       ON CONFLICT(date) DO UPDATE SET ${field} = ${field} + 1`
    ).bind(date, Math.floor(Date.now() / 1000)).run();
  }
}

export function createDbClient(env: Env): DbClient {
  return new DbClient(env.DB);
}
