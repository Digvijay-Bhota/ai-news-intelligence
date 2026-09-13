/**
 * D1 Database Access Layer — Phase 0 (Canonical)
 */

import type { Env, ArticleRaw, Source, Topic, Event, PipelineJob, AiJob, DedupHash, SourceHealth, User, UserFollow, FollowTargetType, UserPreference, SavedArticle, HiddenStory, PipelineToken, EventBriefRow, EventNarrativeDeltaRow, EventClaimComparisonRow, PersonalizedFeedItem, PersonalizedFeedResult, UserEventRead, SinceLastSeenFeedResult, SinceLastSeenInfo, UserProfile } from '../types';
import { getEventFreshness } from '../utils/freshness';
import { RankingEvent, FollowContext, rankEvents, RankingFreshness } from '../utils/ranking';
import { evaluateEventDelta } from '../utils/change-engine';

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

  async getSourceByName(name: string): Promise<Source | null> {
    return this.db.prepare('SELECT * FROM sources WHERE name = ?1').bind(name).first<Source>();
  }

  async getSourcesBatch(sourceIds: number[]): Promise<Map<number, string>> {
    if (sourceIds.length === 0) return new Map();
    const uniqueIds = Array.from(new Set(sourceIds));
    const placeholders = uniqueIds.map(() => '?').join(',');
    const query = `SELECT id, name FROM sources WHERE id IN (${placeholders})`;
    const res = await this.db.prepare(query).bind(...uniqueIds).all<{ id: number; name: string }>();

    const map = new Map<number, string>();
    if (res.results) {
      for (const row of res.results) {
        map.set(row.id, row.name);
      }
    }
    return map;
  }

  async getIntelligenceBatch(articleIds: number[]): Promise<Map<number, { topics: string[]; events: { title: string; hash: string }[] }>> {
    const map = new Map<number, { topics: string[]; events: { title: string; hash: string }[] }>();
    if (articleIds.length === 0) return map;

    for (const id of articleIds) {
      map.set(id, { topics: [], events: [] });
    }

    const uniqueIds = Array.from(new Set(articleIds));
    const placeholders = uniqueIds.map(() => '?').join(',');

    const topicsQuery = `
      SELECT at.article_raw_id, t.name
      FROM article_topics at
      JOIN topics t ON t.id = at.topic_id
      WHERE at.article_raw_id IN (${placeholders})
    `;
    const topicsRes = await this.db.prepare(topicsQuery).bind(...uniqueIds).all<{ article_raw_id: number; name: string }>();

    const eventsQuery = `
      SELECT ae.article_raw_id, e.title, e.event_hash
      FROM article_events ae
      JOIN events e ON e.id = ae.event_id
      WHERE ae.article_raw_id IN (${placeholders})
    `;
    const eventsRes = await this.db.prepare(eventsQuery).bind(...uniqueIds).all<{ article_raw_id: number; title: string; event_hash: string }>();

    if (topicsRes.results) {
      for (const row of topicsRes.results) {
        map.get(row.article_raw_id)?.topics.push(row.name);
      }
    }

    if (eventsRes.results) {
      for (const row of eventsRes.results) {
        map.get(row.article_raw_id)?.events.push({ title: row.title, hash: row.event_hash });
      }
    }

    return map;
  }


  // ─── Articles Raw ─────────────────────────────────────────
  async getArticleById(id: number): Promise<ArticleRaw | null> {
    return this.db.prepare('SELECT * FROM articles_raw WHERE id = ?1').bind(id).first<ArticleRaw>();
  }

  async getArticleDetailById(id: number) {
    const article = await this.getArticleById(id);
    if (!article) return null;

    const source = await this.getSourceById(article.source_id);
    const content = await this.db.prepare('SELECT cleaned_text, extracted_entities FROM article_content WHERE article_raw_id = ?1').bind(id).first<{ cleaned_text: string | null; extracted_entities: string | null }>();

    const topicsQuery = `
      SELECT t.name, t.slug
      FROM article_topics at
      JOIN topics t ON t.id = at.topic_id
      WHERE at.article_raw_id = ?1
    `;
    const topicsRes = await this.db.prepare(topicsQuery).bind(id).all<{ name: string; slug: string }>();

    const eventsQuery = `
      SELECT e.event_hash, e.title, e.description, e.severity, e.started_at
      FROM article_events ae
      JOIN events e ON e.id = ae.event_id
      WHERE ae.article_raw_id = ?1
    `;
    const eventsRes = await this.db.prepare(eventsQuery).bind(id).all<{ event_hash: string; title: string; description: string; severity: string; started_at: number }>();

    let extracted_entities: any[] = [];
    if (content?.extracted_entities) {
      try {
        const parsed = JSON.parse(content.extracted_entities);
        extracted_entities = Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        // Fallback for malformed JSON
        extracted_entities = [];
      }
    }

    return {
      id: article.id,
      external_id: article.external_id,
      title: article.title,
      summary: article.summary,
      cleaned_text: content?.cleaned_text ?? null,
      url: article.url,
      source: source?.name ?? 'unknown',
      published_at: article.published_at,
      topics: topicsRes.results ?? [],
      events: eventsRes.results ?? [],
      extracted_entities,
    };
  }

  async getArticleByExternalId(externalId: string): Promise<ArticleRaw | null> {
    return this.db.prepare('SELECT * FROM articles_raw WHERE external_id = ?1').bind(externalId).first<ArticleRaw>();
  }


  async getActiveEvents(
    nowSeconds: number,
    options: {
      freshness?: string;
      severity?: string;
      min_articles?: number;
      sort?: string;
    } = {}
  ): Promise<{
    items: { hash: string; title: string; description: string | null; severity: string; started_at: number | null; article_count: number; last_published_at: number | null }[];
    summary: { total: number; developing: number; active: number; stale: number; }
  }> {
    const { freshness, severity, min_articles = 0, sort = 'priority' } = options;

    const conditions: string[] = ['1=1'];
    const params: (string | number)[] = [];

    let needsNow = false;
    if (freshness) needsNow = true;
    if (sort === 'priority') needsNow = true;

    let nowIdx = -1;
    if (needsNow) {
      params.push(nowSeconds);
      nowIdx = params.length;
    }

    if (severity) {
      params.push(severity);
      conditions.push(`s.severity = ?${params.length}`);
    }

    if (min_articles > 0) {
      params.push(min_articles);
      conditions.push(`s.article_count >= ?${params.length}`);
    }

    if (freshness === 'developing') {
      conditions.push(`s.last_published_at > (?${nowIdx} - 86400) AND s.article_count > 1`);
    } else if (freshness === 'stale') {
      conditions.push(`s.last_published_at <= (?${nowIdx} - 172800)`);
    } else if (freshness === 'active') {
      conditions.push(`(s.last_published_at IS NULL OR (s.last_published_at > (?${nowIdx} - 172800) AND NOT (s.last_published_at > (?${nowIdx} - 86400) AND s.article_count > 1)))`);
    }

    let orderClause = '';
    if (sort === 'recent') {
      orderClause = 'ORDER BY s.last_published_at DESC, s.article_count DESC, s.id DESC';
    } else if (sort === 'coverage') {
      orderClause = 'ORDER BY s.article_count DESC, s.last_published_at DESC, s.id DESC';
    } else {
      orderClause = `ORDER BY
        CASE
          WHEN s.last_published_at > (?${nowIdx} - 86400) AND s.article_count > 1 THEN 1
          WHEN s.last_published_at <= (?${nowIdx} - 172800) THEN 3
          ELSE 2
        END ASC,
        CASE s.severity
          WHEN 'critical' THEN 1
          WHEN 'high' THEN 2
          WHEN 'warning' THEN 3
          WHEN 'medium' THEN 4
          WHEN 'info' THEN 5
          WHEN 'low' THEN 6
          ELSE 7
        END ASC,
        s.article_count DESC,
        s.last_published_at DESC,
        s.id DESC`;
    }

    const statsQuery = `
      SELECT
        e.id,
        e.event_hash as hash,
        e.title,
        e.description,
        e.severity,
        e.started_at,
        COUNT(ae.article_raw_id) as article_count,
        COUNT(DISTINCT a.source_id) as source_count,
        MIN(a.published_at) as first_published_at,
        MAX(a.published_at) as last_published_at
      FROM events e
      LEFT JOIN article_events ae ON e.id = ae.event_id
      LEFT JOIN articles_raw a ON ae.article_raw_id = a.id
      WHERE e.status = 'active'
      GROUP BY e.id
    `;

    const summaryQuery = `
      WITH stats AS (${statsQuery})
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN last_published_at > (?1 - 86400) AND article_count > 1 THEN 1 ELSE 0 END) as developing,
        SUM(CASE WHEN last_published_at <= (?1 - 172800) THEN 1 ELSE 0 END) as stale,
        SUM(CASE WHEN (last_published_at IS NULL) OR (last_published_at > (?1 - 172800) AND NOT (last_published_at > (?1 - 86400) AND article_count > 1)) THEN 1 ELSE 0 END) as active
      FROM stats
    `;

    const itemsQuery = `
      WITH stats AS (${statsQuery})
      SELECT s.* FROM stats s
      WHERE ${conditions.join(' AND ')}
      ${orderClause}
      LIMIT 50
    `;

    const [summaryRes, itemsRes] = await this.db.batch([
      this.db.prepare(summaryQuery).bind(nowSeconds),
      this.db.prepare(itemsQuery).bind(...params)
    ]);

    const summaryRow = (summaryRes.results?.[0] as { total?: number; developing?: number; active?: number; stale?: number }) ?? {};
    const summary = {
      total: Number(summaryRow.total ?? 0),
      developing: Number(summaryRow.developing ?? 0),
      active: Number(summaryRow.active ?? 0),
      stale: Number(summaryRow.stale ?? 0),
    };

    return {
      items: (itemsRes.results as { hash: string; title: string; description: string | null; severity: string; started_at: number | null; article_count: number; source_count?: number; first_published_at?: number | null; last_published_at: number | null }[]) ?? [],
      summary
    };
  }

  async getEventDetailByHash(hash: string): Promise<{ event: { id?: number; hash: string; title: string; description: string | null; severity: string; started_at: number | null }; coverage: { total_articles: number; total_sources: number; first_published_at: number | null; last_published_at: number | null; sources: { name: string; article_count: number; first_published_at: number | null; }[] }; articles: (ArticleRaw & { extracted_entities?: string | null })[] } | null> {
    const event = await this.db.prepare(
      'SELECT id, event_hash as hash, title, description, severity, started_at FROM events WHERE event_hash = ?1'
    ).bind(hash).first<{ id: number; hash: string; title: string; description: string | null; severity: string; started_at: number | null }>();

    if (!event) return null;

    const coverageQuery = `
      SELECT
        s.name,
        COUNT(a.id) AS article_count,
        MIN(a.published_at) AS first_published_at,
        MAX(a.published_at) AS last_published_at
      FROM articles_raw a
      JOIN article_events ae ON a.id = ae.article_raw_id
      JOIN events e ON ae.event_id = e.id
      JOIN sources s ON a.source_id = s.id
      WHERE e.event_hash = ?1
      GROUP BY s.id, s.name
      ORDER BY first_published_at ASC
    `;
    const coverageRes = await this.db.prepare(coverageQuery).bind(hash).all<{ name: string; article_count: number; first_published_at: number | null; last_published_at: number | null }>();

    const sources = coverageRes.results ?? [];
    let total_articles = 0;
    let first_published_at: number | null = null;
    let last_published_at: number | null = null;

    for (const src of sources) {
      total_articles += src.article_count;
      if (src.first_published_at !== null) {
        if (first_published_at === null || src.first_published_at < first_published_at) {
          first_published_at = src.first_published_at;
        }
      }
      if (src.last_published_at !== null) {
        if (last_published_at === null || src.last_published_at > last_published_at) {
          last_published_at = src.last_published_at;
        }
      }
    }

    const coverage = {
      total_articles,
      total_sources: sources.length,
      first_published_at,
      last_published_at,
      sources
    };

    const query = `
      SELECT a.*, ac.extracted_entities
      FROM articles_raw a
      JOIN article_events ae ON a.id = ae.article_raw_id
      JOIN events e ON ae.event_id = e.id
      LEFT JOIN article_content ac ON a.id = ac.article_raw_id
      WHERE e.event_hash = ?1
      ORDER BY a.published_at ASC, a.id ASC
      LIMIT 100
    `;
    const articlesRes = await this.db.prepare(query).bind(hash).all<ArticleRaw & { extracted_entities?: string | null }>();

    return {
      event,
      coverage,
      articles: articlesRes.results ?? []
    };
  }

  async listArticles(options: {
    limit?: number;
    offset?: number;
    source_id?: number;
    source_names?: string[];
    status?: string;
    q?: string;
    topic_slug?: string;
    topics?: string[];
    orderBy?: 'published_at' | 'created_at';
    order?: 'ASC' | 'DESC';
  } = {}): Promise<{ articles: ArticleRaw[]; total: number }> {
    const { limit = 20, offset = 0, source_id, source_names, status, q, topic_slug, topics, orderBy = 'published_at', order = 'DESC' } = options;

    const conditions: string[] = [];
    const params: (string | number)[] = [];
    let joinClause = '';

    if (source_id !== undefined) {
      params.push(source_id);
      conditions.push('articles_raw.source_id = ?' + params.length);
    }

    if (source_names && source_names.length > 0) {
      if (!joinClause.includes('JOIN sources')) {
        joinClause += ' JOIN sources ON articles_raw.source_id = sources.id';
      }
      const placeholders = source_names.map(s => {
        params.push(s);
        return '?' + params.length;
      }).join(',');
      conditions.push(`sources.name IN (${placeholders})`);
    }

    if (status) {
      params.push(status);
      conditions.push('articles_raw.status = ?' + params.length);
    }
    if (q) {
      params.push(`%${q}%`, `%${q}%`);
      conditions.push(`(articles_raw.title LIKE ?${params.length - 1} OR articles_raw.summary LIKE ?${params.length})`);
    }

    if (topic_slug || (topics && topics.length > 0)) {
      if (!joinClause.includes('JOIN article_topics')) {
        joinClause += ' JOIN article_topics ON articles_raw.id = article_topics.article_raw_id JOIN topics ON article_topics.topic_id = topics.id';
      }
      if (topic_slug) {
        params.push(topic_slug);
        conditions.push(`topics.slug = ?${params.length}`);
      }
      if (topics && topics.length > 0) {
        const placeholders = topics.map(t => {
          params.push(t);
          return '?' + params.length;
        }).join(',');
        conditions.push(`topics.slug IN (${placeholders})`);
      }
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countResult = await this.db
      .prepare(`SELECT COUNT(DISTINCT articles_raw.id) as total FROM articles_raw ${joinClause} ${where}`)
      .bind(...params)
      .first<{ total: number }>();

    const articles = await this.db
      .prepare(
        `SELECT DISTINCT articles_raw.* FROM articles_raw ${joinClause} ${where}
         ORDER BY articles_raw.${orderBy} ${order}
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
    await this.db.prepare('UPDATE articles_raw SET status = ?1, updated_at = unixepoch() WHERE id = ?2').bind(status, id).run();
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
        `INSERT INTO article_content (article_raw_id, cleaned_text, extracted_entities)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(article_raw_id) DO UPDATE SET
           cleaned_text = excluded.cleaned_text,
           extracted_entities = excluded.extracted_entities,
           processed_at = unixepoch()`
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
      .prepare('INSERT OR IGNORE INTO article_topics (article_raw_id, topic_id, confidence) VALUES (?1, ?2, ?3)')
      .bind(article_raw_id, topic_id, confidence)
      .run();
  }

  async createEvent(event: Omit<Event, 'id' | 'created_at'>): Promise<number> {
    const result = await this.db
      .prepare(
        'INSERT OR IGNORE INTO events (event_hash, title, description, severity, started_at, ended_at, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id'
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

    if (result) {
      return result.id;
    }

    // If ignored, the event_hash already exists
    const existing = await this.db
      .prepare('SELECT id FROM events WHERE event_hash = ?1')
      .bind(event.event_hash)
      .first<{ id: number }>();

    if (!existing) throw new Error('Failed to create or retrieve event');

    return existing.id;
  }

  async linkArticleEvent(article_raw_id: number, event_id: number, relevance_score: number): Promise<void> {
    await this.db
      .prepare('INSERT OR IGNORE INTO article_events (article_raw_id, event_id, relevance_score) VALUES (?1, ?2, ?3)')
      .bind(article_raw_id, event_id, relevance_score)
      .run();
  }

  async getRecentActiveEvents(limit: number): Promise<{ id: number; event_hash: string; title: string; description: string | null; severity: string }[]> {
    const query = `
      SELECT e.id, e.event_hash, e.title, e.description, e.severity
      FROM events e
      LEFT JOIN article_events ae ON e.id = ae.event_id
      LEFT JOIN articles_raw a ON ae.article_raw_id = a.id
      WHERE e.status = 'active'
      GROUP BY e.id
      ORDER BY COALESCE(MAX(a.published_at), e.created_at) DESC
      LIMIT ?1
    `;
    const r = await this.db.prepare(query).bind(limit).all<{ id: number; event_hash: string; title: string; description: string | null; severity: string }>();
    return r.results ?? [];
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
        'UPDATE articles_raw SET status = "processing", updated_at = unixepoch() WHERE id = ?1 AND status = "pending"'
      )
      .bind(id)
      .run();
    return result.meta.changes === 1;
  }

  async claimFailedArticle(id: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        'UPDATE articles_raw SET status = "processing", updated_at = unixepoch() WHERE id = ?1 AND status = "failed"'
      )
      .bind(id)
      .run();
    return result.meta.changes === 1;
  }

  async recoverStaleProcessingArticles(timeoutSeconds: number = 900): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE articles_raw
         SET status = 'failed', updated_at = unixepoch()
         WHERE status = 'processing'
           AND updated_at < unixepoch() - ?1`
      )
      .bind(timeoutSeconds)
      .run();
    return result.meta.changes;
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
        `INSERT INTO source_health (source_id, status, last_success_at, last_failure_at, consecutive_failures, error_message, checked_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(source_id) DO UPDATE SET
           status = excluded.status,
           last_success_at = excluded.last_success_at,
           last_failure_at = excluded.last_failure_at,
           consecutive_failures = excluded.consecutive_failures,
           error_message = excluded.error_message,
           checked_at = excluded.checked_at`
      )
      .bind(
        source_id,
        data.status,
        data.last_success_at ?? null,
        data.last_failure_at ?? null,
        data.consecutive_failures,
        data.error_message,
        now
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

  // ─── Community Identity (Phase 13A) ───
  async getUserProfile(userId: string): Promise<UserProfile | null> {
    const profile = await this.db
      .prepare('SELECT * FROM user_profiles WHERE user_id = ?1')
      .bind(userId)
      .first<UserProfile>();
    return profile || null;
  }

  async createUserProfile(params: { user_id: string; public_id: string; display_name: string; status: string }): Promise<UserProfile> {
    const now = Math.floor(Date.now() / 1000);
    const profile = await this.db
      .prepare(
        'INSERT INTO user_profiles (user_id, public_id, display_name, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5) RETURNING *'
      )
      .bind(params.user_id, params.public_id, params.display_name, params.status, now)
      .first<UserProfile>();

    if (!profile) throw new Error('Failed to create user profile');
    return profile;
  }

  async updateUserProfile(userId: string, displayName: string): Promise<UserProfile | null> {
    const now = Math.floor(Date.now() / 1000);
    const profile = await this.db
      .prepare(
        'UPDATE user_profiles SET display_name = ?2, updated_at = ?3 WHERE user_id = ?1 RETURNING *'
      )
      .bind(userId, displayName, now)
      .first<UserProfile>();
    return profile || null;
  }

  // ─── Users (Durable Anonymous Identity — Phase 11A/11C) ───
  async getOrCreateUser(userId: string): Promise<User> {
    const now = Math.floor(Date.now() / 1000);
    const existing = await this.db
      .prepare('SELECT * FROM users WHERE id = ?1')
      .bind(userId)
      .first<User>();

    if (existing) {
      let ackThrough = existing.acknowledged_through;
      let needsAckUpdate = false;
      // Self-heal migration boundary if acknowledged_through is uninitialized (0 or null)
      if (!ackThrough || ackThrough === 0) {
        ackThrough = now;
        needsAckUpdate = true;
      }
      const activeOutdated = now - existing.last_active_at > 300;

      if (needsAckUpdate || activeOutdated) {
        await this.db
          .prepare('UPDATE users SET last_active_at = ?1, acknowledged_through = ?2 WHERE id = ?3')
          .bind(activeOutdated ? now : existing.last_active_at, ackThrough, userId)
          .run();
        existing.acknowledged_through = ackThrough;
        if (activeOutdated) existing.last_active_at = now;
      }
      return existing;
    }

    await this.db
      .prepare('INSERT OR IGNORE INTO users (id, created_at, last_active_at, acknowledged_through) VALUES (?1, ?2, ?2, ?2)')
      .bind(userId, now)
      .run();

    const user = await this.db
      .prepare('SELECT * FROM users WHERE id = ?1')
      .bind(userId)
      .first<User>();

    return user ?? { id: userId, created_at: now, last_active_at: now, acknowledged_through: now };
  }

  async getUserById(userId: string): Promise<User | null> {
    return this.db.prepare('SELECT * FROM users WHERE id = ?1').bind(userId).first<User>();
  }

  // ─── User Follows (Topic, Event, Source — Phase 11A) ────────
  async listUserFollows(userId: string, targetType?: FollowTargetType): Promise<UserFollow[]> {
    if (targetType) {
      const res = await this.db
        .prepare('SELECT * FROM user_follows WHERE user_id = ?1 AND target_type = ?2 ORDER BY created_at DESC')
        .bind(userId, targetType)
        .all<UserFollow>();
      return res.results ?? [];
    }
    const res = await this.db
      .prepare('SELECT * FROM user_follows WHERE user_id = ?1 ORDER BY created_at DESC')
      .bind(userId)
      .all<UserFollow>();
    return res.results ?? [];
  }

  async createUserFollow(userId: string, targetType: FollowTargetType, targetId: string): Promise<UserFollow> {
    const now = Math.floor(Date.now() / 1000);
    await this.db
      .prepare(
        'INSERT INTO user_follows (user_id, target_type, target_id, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(user_id, target_type, target_id) DO NOTHING'
      )
      .bind(userId, targetType, targetId, now)
      .run();

    const follow = await this.db
      .prepare('SELECT * FROM user_follows WHERE user_id = ?1 AND target_type = ?2 AND target_id = ?3')
      .bind(userId, targetType, targetId)
      .first<UserFollow>();

    if (!follow) throw new Error('Failed to create or retrieve user follow');
    return follow;
  }

  async deleteUserFollow(userId: string, targetType: FollowTargetType, targetId: string): Promise<boolean> {
    const res = await this.db
      .prepare('DELETE FROM user_follows WHERE user_id = ?1 AND target_type = ?2 AND target_id = ?3')
      .bind(userId, targetType, targetId)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async isUserFollowing(userId: string, targetType: FollowTargetType, targetId: string): Promise<boolean> {
    const res = await this.db
      .prepare('SELECT 1 FROM user_follows WHERE user_id = ?1 AND target_type = ?2 AND target_id = ?3 LIMIT 1')
      .bind(userId, targetType, targetId)
      .first();
    return !!res;
  }

  // ─── Phase 11C: Since-Last-Seen State & Intelligence ────────
  async getUserEventReads(userId: string, eventIds: number[]): Promise<Map<number, UserEventRead>> {
    const map = new Map<number, UserEventRead>();
    if (eventIds.length === 0) return map;
    const uniqueIds = Array.from(new Set(eventIds));
    const placeholders = uniqueIds.map(() => '?').join(',');
    const query = `SELECT * FROM user_event_reads WHERE user_id = ? AND event_id IN (${placeholders})`;
    const res = await this.db.prepare(query).bind(userId, ...uniqueIds).all<UserEventRead>();
    if (res.results) {
      for (const row of res.results) {
        map.set(row.event_id, row);
      }
    }
    return map;
  }

  async getArticlesBeforeAckBatch(eventIds: number[], acknowledgedThrough: number): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    if (eventIds.length === 0) return map;
    const uniqueIds = Array.from(new Set(eventIds));
    const placeholders = uniqueIds.map(() => '?').join(',');
    const query = `
      SELECT ae.event_id, COUNT(DISTINCT a.id) as count
      FROM article_events ae
      JOIN articles_raw a ON ae.article_raw_id = a.id
      WHERE ae.event_id IN (${placeholders}) AND a.published_at <= ?
      GROUP BY ae.event_id
    `;
    const res = await this.db.prepare(query).bind(...uniqueIds, acknowledgedThrough).all<{ event_id: number; count: number }>();
    if (res.results) {
      for (const row of res.results) {
        map.set(row.event_id, row.count);
      }
    }
    return map;
  }

  private async resolveArticlesBeforeAck(
    events: { id: number; article_count: number; started_at: number | null; created_at?: number | null; last_published_at: number | null }[],
    acknowledgedThrough: number
  ): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    const needsQuery: number[] = [];

    for (const e of events) {
      const lastPub = e.last_published_at ?? 0;
      const start = e.started_at ?? e.created_at ?? 0;

      if (lastPub <= acknowledgedThrough) {
        map.set(e.id, e.article_count);
      } else if (start > acknowledgedThrough) {
        map.set(e.id, 0);
      } else {
        needsQuery.push(e.id);
      }
    }

    if (needsQuery.length > 0) {
      const batchMap = await this.getArticlesBeforeAckBatch(needsQuery, acknowledgedThrough);
      for (const id of needsQuery) {
        map.set(id, batchMap.get(id) ?? 0);
      }
    }

    return map;
  }

  async markFeedCaughtUp(userId: string): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    await this.getOrCreateUser(userId);

    const result = await this.db
      .prepare(
        `UPDATE users
         SET acknowledged_through = MAX(COALESCE(acknowledged_through, 0), unixepoch()),
             last_active_at = unixepoch()
         WHERE id = ?1
         RETURNING acknowledged_through`
      )
      .bind(userId)
      .first<{ acknowledged_through: number }>();

    if (result && typeof result.acknowledged_through === 'number') {
      return result.acknowledged_through;
    }

    const user = await this.getUserById(userId);
    return user?.acknowledged_through ?? now;
  }

  async markEventRead(userId: string, eventId: number): Promise<UserEventRead> {
    const now = Math.floor(Date.now() / 1000);
    await this.getOrCreateUser(userId);

    const statsQuery = `
      SELECT
        e.id as event_id,
        COUNT(DISTINCT ae.article_raw_id) as article_count,
        COALESCE((SELECT MAX(version) FROM event_briefs WHERE event_id = e.id AND status = 'completed'), 1) as brief_version,
        COALESCE((SELECT MAX(current_version) FROM event_narrative_deltas WHERE event_id = e.id AND status = 'completed'), 0) as narrative_version,
        COALESCE((SELECT MAX(version) FROM event_claim_comparisons WHERE event_id = e.id AND status = 'completed'), 0) as claim_version
      FROM events e
      LEFT JOIN article_events ae ON e.id = ae.event_id
      WHERE e.id = ?1
      GROUP BY e.id
    `;
    const stats = await this.db.prepare(statsQuery).bind(eventId).first<{
      event_id: number;
      article_count: number;
      brief_version: number;
      narrative_version: number;
      claim_version: number;
    }>();

    const seenArticleCount = stats ? Math.max(stats.article_count, 1) : 1;
    const seenBriefVersion = stats ? Math.max(stats.brief_version, 1) : 1;
    const seenNarrativeVersion = stats ? stats.narrative_version : 0;
    const seenClaimVersion = stats ? stats.claim_version : 0;

    await this.db
      .prepare(
        `INSERT INTO user_event_reads (
           user_id, event_id, read_at,
           seen_article_count, seen_brief_version, seen_narrative_version, seen_claim_version
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(user_id, event_id) DO UPDATE SET
           read_at = excluded.read_at,
           seen_article_count = excluded.seen_article_count,
           seen_brief_version = excluded.seen_brief_version,
           seen_narrative_version = excluded.seen_narrative_version,
           seen_claim_version = excluded.seen_claim_version`
      )
      .bind(
        userId,
        eventId,
        now,
        seenArticleCount,
        seenBriefVersion,
        seenNarrativeVersion,
        seenClaimVersion
      )
      .run();

    return {
      user_id: userId,
      event_id: eventId,
      read_at: now,
      seen_article_count: seenArticleCount,
      seen_brief_version: seenBriefVersion,
      seen_narrative_version: seenNarrativeVersion,
      seen_claim_version: seenClaimVersion,
    };
  }

  // ─── Personalized Intelligence Feed (Phase 11B/11C) ───────────
  async getPersonalizedFeedEvents(
    userId: string,
    nowSeconds: number,
    options: { limit?: number; offset?: number } = {}
  ): Promise<PersonalizedFeedResult> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
    const offset = Math.max(options.offset ?? 0, 0);

    const user = await this.getOrCreateUser(userId);

    // 1. Fetch user follows (single indexed query)
    const follows = await this.listUserFollows(userId);
    const followContext: FollowContext = {
      eventIds: new Set<string>(),
      topicSlugs: new Set<string>(),
      sourceNames: new Set<string>(),
    };

    for (const f of follows) {
      if (f.target_type === 'event') {
        followContext.eventIds.add(f.target_id);
      } else if (f.target_type === 'topic') {
        followContext.topicSlugs.add(f.target_id.trim().toLowerCase());
      } else if (f.target_type === 'source') {
        followContext.sourceNames.add(f.target_id.trim().toLowerCase());
      }
    }

    const user_has_follows =
      followContext.eventIds.size > 0 ||
      followContext.topicSlugs.size > 0 ||
      followContext.sourceNames.size > 0;

    // 2. Candidate query (bounded CTE aggregation avoiding row multiplication)
    const candidateQuery = `
      WITH active_events AS (
        SELECT
          e.id,
          e.event_hash as hash,
          e.title,
          e.description,
          e.severity,
          e.status,
          e.started_at,
          e.created_at,
          COUNT(DISTINCT ae.article_raw_id) as article_count,
          COUNT(DISTINCT a.source_id) as source_count,
          MAX(a.published_at) as last_published_at
        FROM events e
        LEFT JOIN article_events ae ON e.id = ae.event_id
        LEFT JOIN articles_raw a ON ae.article_raw_id = a.id
        WHERE e.status = 'active'
        GROUP BY e.id
      ),
      event_topics_agg AS (
        SELECT ae.event_id, GROUP_CONCAT(DISTINCT t.slug) as topic_slugs
        FROM article_events ae
        JOIN article_topics at ON ae.article_raw_id = at.article_raw_id
        JOIN topics t ON at.topic_id = t.id
        GROUP BY ae.event_id
      ),
      event_sources_agg AS (
        SELECT ae.event_id, GROUP_CONCAT(DISTINCT s.name) as source_names
        FROM article_events ae
        JOIN articles_raw a ON ae.article_raw_id = a.id
        JOIN sources s ON a.source_id = s.id
        GROUP BY ae.event_id
      ),
      event_intel_agg AS (
        SELECT event_id, MAX(version) as brief_version, MAX(updated_at) as brief_updated_at
        FROM event_briefs
        WHERE status = 'completed'
        GROUP BY event_id
      ),
      event_deltas_agg AS (
        SELECT event_id, COUNT(*) as delta_count, MAX(created_at) as delta_created_at
        FROM event_narrative_deltas
        WHERE status = 'completed'
        GROUP BY event_id
      ),
      event_claims_agg AS (
        SELECT event_id, COUNT(*) as claim_comp_count, MAX(version) as claim_version, MAX(created_at) as claim_created_at
        FROM event_claim_comparisons
        WHERE status = 'completed'
        GROUP BY event_id
      )
      SELECT
        ae.id,
        ae.hash,
        ae.title,
        ae.description,
        ae.severity,
        ae.status,
        ae.started_at,
        ae.created_at,
        ae.article_count,
        ae.source_count,
        ae.last_published_at,
        COALESCE(eta.topic_slugs, '') as topic_slugs_raw,
        COALESCE(esa.source_names, '') as source_names_raw,
        COALESCE(eia.brief_version, 0) as brief_version,
        COALESCE(eia.brief_updated_at, 0) as brief_updated_at,
        CASE WHEN eda.delta_count > 0 THEN 1 ELSE 0 END as has_narrative_delta,
        COALESCE(eda.delta_created_at, 0) as delta_created_at,
        CASE WHEN eca.claim_comp_count > 0 THEN 1 ELSE 0 END as has_claim_comparison,
        COALESCE(eca.claim_version, 0) as claim_version,
        COALESCE(eca.claim_created_at, 0) as claim_created_at
      FROM active_events ae
      LEFT JOIN event_topics_agg eta ON ae.id = eta.event_id
      LEFT JOIN event_sources_agg esa ON ae.id = esa.event_id
      LEFT JOIN event_intel_agg eia ON ae.id = eia.event_id
      LEFT JOIN event_deltas_agg eda ON ae.id = eda.event_id
      LEFT JOIN event_claims_agg eca ON ae.id = eca.event_id
      ORDER BY ae.last_published_at DESC, ae.id DESC
      LIMIT 50;
    `;

    interface CandidateRow {
      id: number;
      hash: string;
      title: string;
      description: string | null;
      severity: string | null;
      status: string;
      started_at: number | null;
      created_at: number | null;
      article_count: number;
      source_count: number;
      last_published_at: number | null;
      topic_slugs_raw: string;
      source_names_raw: string;
      brief_version: number;
      brief_updated_at: number | null;
      has_narrative_delta: number;
      delta_created_at: number | null;
      has_claim_comparison: number;
      claim_version: number;
      claim_created_at: number | null;
    }

    const candidateRes = await this.db.prepare(candidateQuery).bind().all<CandidateRow>();
    const rows = candidateRes.results ?? [];

    // Fetch user reads and articles before ack for delta computation
    const eventIds = rows.map(r => r.id);
    const [readsMap, articlesBeforeAckMap] = await Promise.all([
      this.getUserEventReads(userId, eventIds),
      this.resolveArticlesBeforeAck(rows, user.acknowledged_through),
    ]);

    const deltaMap = new Map<number, SinceLastSeenInfo>();
    for (const r of rows) {
      const userRead = readsMap.get(r.id) ?? null;
      const articlesBeforeAck = articlesBeforeAckMap.get(r.id) ?? 0;
      const delta = evaluateEventDelta({
        started_at: r.started_at,
        created_at: r.created_at,
        last_published_at: r.last_published_at,
        article_count: r.article_count,
        source_count: r.source_count,
        brief_version: r.brief_version,
        brief_updated_at: r.brief_updated_at,
        delta_created_at: r.delta_created_at,
        claim_version: r.claim_version,
        claim_created_at: r.claim_created_at,
        acknowledged_through: user.acknowledged_through,
        articles_before_ack: articlesBeforeAck,
        user_read: userRead,
      });
      deltaMap.set(r.id, delta);
    }

    // 3. Map to RankingEvent with canonical freshness
    const candidateEvents: (RankingEvent & { title: string; description: string | null; started_at: number | null })[] = rows.map(r => {
      const topic_slugs = r.topic_slugs_raw ? r.topic_slugs_raw.split(',').map(s => s.trim()).filter(Boolean) : [];
      const source_names = r.source_names_raw ? r.source_names_raw.split(',').map(s => s.trim()).filter(Boolean) : [];
      const freshness = getEventFreshness(r.last_published_at, r.article_count, nowSeconds);

      return {
        id: r.id,
        hash: r.hash,
        title: r.title,
        description: r.description,
        severity: r.severity ?? 'info',
        started_at: r.started_at,
        last_published_at: r.last_published_at,
        article_count: r.article_count,
        source_count: r.source_count,
        freshness,
        brief_version: r.brief_version,
        has_narrative_delta: r.has_narrative_delta === 1,
        has_claim_comparison: r.has_claim_comparison === 1,
        topic_slugs,
        source_names,
      };
    });

    // 4. Deterministic ranking in Worker memory
    const ranked = rankEvents(candidateEvents, followContext, nowSeconds);

    // 5. Determine fallback status
    const anyFollowMatched = ranked.some(r => r.follow_score > 0);
    const fallback_applied = user_has_follows && !anyFollowMatched;

    // 6. Pagination
    const total = ranked.length;
    const paginated = ranked.slice(offset, offset + limit);

    const items: PersonalizedFeedItem[] = paginated.map(r => ({
      id: r.event.id,
      hash: r.event.hash,
      title: r.event.title,
      description: r.event.description,
      severity: r.event.severity ?? 'info',
      freshness: r.event.freshness,
      article_count: r.event.article_count,
      source_count: r.event.source_count,
      started_at: r.event.started_at,
      last_published_at: r.event.last_published_at,
      topics: r.event.topic_slugs,
      sources: r.event.source_names,
      brief_version: r.event.brief_version,
      has_narrative_delta: r.event.has_narrative_delta,
      has_claim_comparison: r.event.has_claim_comparison,
      score: r.score,
      rank_reasons: r.rank_reasons,
      since_last_seen: deltaMap.get(r.event.id),
    }));

    let unread_event_count = 0;
    let updated_event_count = 0;
    for (const delta of deltaMap.values()) {
      if (delta.change_type === 'NEW_EVENT') {
        unread_event_count++;
      } else if (delta.has_updates) {
        updated_event_count++;
      }
    }
    const all_caught_up = unread_event_count === 0 && updated_event_count === 0;

    return {
      items,
      meta: {
        total,
        limit,
        offset,
        user_has_follows,
        fallback_applied,
        acknowledged_through: user.acknowledged_through,
        unread_event_count,
        updated_event_count,
        all_caught_up,
      },
    };
  }

  // ─── Dedicated Catch-Up Feed (Phase 11C) ─────────────────────
  async getSinceLastSeenEvents(
    userId: string,
    nowSeconds: number,
    options: { limit?: number; offset?: number } = {}
  ): Promise<SinceLastSeenFeedResult> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
    const offset = Math.max(options.offset ?? 0, 0);

    const user = await this.getOrCreateUser(userId);
    const follows = await this.listUserFollows(userId);
    const followContext: FollowContext = {
      eventIds: new Set<string>(),
      topicSlugs: new Set<string>(),
      sourceNames: new Set<string>(),
    };

    for (const f of follows) {
      if (f.target_type === 'event') {
        followContext.eventIds.add(f.target_id);
      } else if (f.target_type === 'topic') {
        followContext.topicSlugs.add(f.target_id.trim().toLowerCase());
      } else if (f.target_type === 'source') {
        followContext.sourceNames.add(f.target_id.trim().toLowerCase());
      }
    }

    // Catch-up candidate query:
    // Computes canonical event_change_cursor across all active events and applies
    // MANDATORY ORDER BY ec.event_change_cursor DESC, ec.id DESC LIMIT 50 BEFORE pagination.
    const catchUpQuery = `
      WITH user_anchor AS (
        SELECT acknowledged_through
        FROM users
        WHERE id = ?1
      ),
      event_activity AS (
        SELECT
          e.id,
          e.event_hash as hash,
          e.title,
          e.description,
          e.severity,
          e.status,
          e.started_at,
          e.created_at,
          MAX(a.published_at) as last_published_at,
          COUNT(DISTINCT ae.article_raw_id) as article_count,
          COUNT(DISTINCT a.source_id) as source_count,
          (SELECT MAX(b.version) FROM event_briefs b WHERE b.event_id = e.id AND b.status = 'completed') as brief_version,
          (SELECT MAX(b.updated_at) FROM event_briefs b WHERE b.event_id = e.id AND b.status = 'completed') as brief_updated_at,
          (SELECT MAX(nd.created_at) FROM event_narrative_deltas nd WHERE nd.event_id = e.id AND nd.status = 'completed') as delta_created_at,
          (SELECT MAX(cc.version) FROM event_claim_comparisons cc WHERE cc.event_id = e.id AND cc.status = 'completed') as claim_version,
          (SELECT MAX(cc.created_at) FROM event_claim_comparisons cc WHERE cc.event_id = e.id AND cc.status = 'completed') as claim_created_at
        FROM events e
        LEFT JOIN article_events ae ON e.id = ae.event_id
        LEFT JOIN articles_raw a ON ae.article_raw_id = a.id
        WHERE e.status = 'active'
        GROUP BY e.id
      ),
      event_cursors AS (
        SELECT
          ea.*,
          MAX(
            COALESCE(ea.last_published_at, 0),
            COALESCE(ea.started_at, ea.created_at, 0),
            COALESCE(ea.brief_updated_at, 0),
            COALESCE(ea.delta_created_at, 0),
            COALESCE(ea.claim_created_at, 0)
          ) as event_change_cursor
        FROM event_activity ea
      ),
      catch_up_candidates AS (
        SELECT
          ec.*
        FROM event_cursors ec
        CROSS JOIN user_anchor ua
        WHERE ec.event_change_cursor > ua.acknowledged_through
        ORDER BY ec.event_change_cursor DESC, ec.id DESC
        LIMIT 50
      ),
      event_topics_agg AS (
        SELECT ae.event_id, GROUP_CONCAT(DISTINCT t.slug) as topic_slugs
        FROM article_events ae
        JOIN catch_up_candidates c ON ae.event_id = c.id
        JOIN article_topics at ON ae.article_raw_id = at.article_raw_id
        JOIN topics t ON at.topic_id = t.id
        GROUP BY ae.event_id
      ),
      event_sources_agg AS (
        SELECT ae.event_id, GROUP_CONCAT(DISTINCT s.name) as source_names
        FROM article_events ae
        JOIN catch_up_candidates c ON ae.event_id = c.id
        JOIN articles_raw a ON ae.article_raw_id = a.id
        JOIN sources s ON a.source_id = s.id
        GROUP BY ae.event_id
      )
      SELECT
        c.*,
        COALESCE(eta.topic_slugs, '') as topic_slugs_raw,
        COALESCE(esa.source_names, '') as source_names_raw
      FROM catch_up_candidates c
      LEFT JOIN event_topics_agg eta ON c.id = eta.event_id
      LEFT JOIN event_sources_agg esa ON c.id = esa.event_id
      ORDER BY c.event_change_cursor DESC, c.id DESC;
    `;

    interface CatchUpRow {
      id: number;
      hash: string;
      title: string;
      description: string | null;
      severity: string | null;
      status: string;
      started_at: number | null;
      created_at: number | null;
      last_published_at: number | null;
      article_count: number;
      source_count: number;
      brief_version: number | null;
      brief_updated_at: number | null;
      delta_created_at: number | null;
      claim_version: number | null;
      claim_created_at: number | null;
      event_change_cursor: number;
      topic_slugs_raw: string;
      source_names_raw: string;
    }

    const res = await this.db.prepare(catchUpQuery).bind(userId).all<CatchUpRow>();
    const rows = res.results ?? [];

    if (rows.length === 0) {
      return {
        items: [],
        meta: {
          total_changed_events: 0,
          acknowledged_through: user.acknowledged_through,
          all_caught_up: true,
          limit,
          offset,
        },
      };
    }

    const eventIds = rows.map(r => r.id);
    const [readsMap, articlesBeforeAckMap] = await Promise.all([
      this.getUserEventReads(userId, eventIds),
      this.resolveArticlesBeforeAck(rows, user.acknowledged_through),
    ]);

    const changedCandidates: (PersonalizedFeedItem & { event_change_cursor: number })[] = [];

    for (const r of rows) {
      const topic_slugs = r.topic_slugs_raw ? r.topic_slugs_raw.split(',').map(s => s.trim()).filter(Boolean) : [];
      const source_names = r.source_names_raw ? r.source_names_raw.split(',').map(s => s.trim()).filter(Boolean) : [];
      const freshness = getEventFreshness(r.last_published_at, r.article_count, nowSeconds);
      const userRead = readsMap.get(r.id) ?? null;
      const articlesBeforeAck = articlesBeforeAckMap.get(r.id) ?? 0;

      const deltaInfo = evaluateEventDelta({
        started_at: r.started_at,
        created_at: r.created_at,
        last_published_at: r.last_published_at,
        article_count: r.article_count,
        source_count: r.source_count,
        brief_version: r.brief_version ?? 0,
        brief_updated_at: r.brief_updated_at,
        delta_created_at: r.delta_created_at,
        claim_version: r.claim_version ?? 0,
        claim_created_at: r.claim_created_at,
        acknowledged_through: user.acknowledged_through,
        articles_before_ack: articlesBeforeAck,
        user_read: userRead,
      });

      if (deltaInfo.change_type !== null) {
        changedCandidates.push({
          id: r.id,
          hash: r.hash,
          title: r.title,
          description: r.description,
          severity: r.severity ?? 'info',
          freshness,
          article_count: r.article_count,
          source_count: r.source_count,
          started_at: r.started_at,
          last_published_at: r.last_published_at,
          topics: topic_slugs,
          sources: source_names,
          brief_version: r.brief_version ?? 0,
          has_narrative_delta: (r.delta_created_at ?? 0) > 0,
          has_claim_comparison: (r.claim_created_at ?? 0) > 0,
          score: 0,
          rank_reasons: [],
          since_last_seen: deltaInfo,
          event_change_cursor: r.event_change_cursor,
        });
      }
    }

    // Rank candidates using Phase 11B ranking for follow boosts
    const rankingEvents: RankingEvent[] = changedCandidates.map(c => ({
      id: c.id,
      hash: c.hash,
      severity: c.severity,
      last_published_at: c.last_published_at,
      article_count: c.article_count,
      source_count: c.source_count,
      freshness: c.freshness as RankingFreshness,
      brief_version: c.brief_version,
      has_narrative_delta: c.has_narrative_delta,
      has_claim_comparison: c.has_claim_comparison,
      topic_slugs: c.topics,
      source_names: c.sources,
    }));

    const ranked = rankEvents(rankingEvents, followContext, nowSeconds);
    const scoreMap = new Map<number, { score: number; rank_reasons: string[] }>();
    for (const r of ranked) {
      scoreMap.set(r.event.id, { score: r.score, rank_reasons: r.rank_reasons });
    }

    for (const item of changedCandidates) {
      const s = scoreMap.get(item.id);
      if (s) {
        item.score = s.score;
        item.rank_reasons = s.rank_reasons;
      }
    }

    // Final result ordering: ORDER BY event_change_cursor DESC, event_id DESC
    changedCandidates.sort((a, b) => {
      if (b.event_change_cursor !== a.event_change_cursor) {
        return b.event_change_cursor - a.event_change_cursor;
      }
      return b.id - a.id;
    });

    const totalChanged = changedCandidates.length;
    const paginated = changedCandidates.slice(offset, offset + limit).map(c => {
      const { event_change_cursor, ...rest } = c;
      return rest;
    });

    return {
      items: paginated,
      meta: {
        total_changed_events: totalChanged,
        acknowledged_through: user.acknowledged_through,
        all_caught_up: totalChanged === 0,
        limit,
        offset,
      },
    };
  }

  // ─── User Preferences ─────────────────────────────────────
  async getUserPreferences(userId: string): Promise<UserPreference | null> {
    return this.db.prepare('SELECT * FROM user_preferences WHERE user_id = ?1').bind(userId).first<UserPreference>();
  }

  async upsertUserPreferences(prefs: Omit<UserPreference, 'id' | 'created_at' | 'updated_at'>): Promise<UserPreference> {
    const now = Math.floor(Date.now() / 1000);
    const result = await this.db
      .prepare(
        `INSERT INTO user_preferences (user_id, preferred_topics, preferred_sources, digest_frequency, email, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(user_id) DO UPDATE SET
           preferred_topics = excluded.preferred_topics,
           preferred_sources = excluded.preferred_sources,
           digest_frequency = excluded.digest_frequency,
           email = excluded.email,
           updated_at = excluded.updated_at
         RETURNING *`
      )
      .bind(prefs.user_id, prefs.preferred_topics ?? null, prefs.preferred_sources ?? null, prefs.digest_frequency, prefs.email ?? null, now, now)
      .first<UserPreference>();
    if (!result) throw new Error('Failed to upsert preferences');
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

    if (!result) {
      const existing = await this.db
        .prepare('SELECT * FROM hidden_stories WHERE user_id = ?1 AND article_raw_id = ?2')
        .bind(userId, articleRawId)
        .first<HiddenStory>();
      if (!existing) throw new Error('Failed to hide story');
      return existing;
    }

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

  // ─── Event Briefs (Grounded AI Summaries) ──────────────────
  async hasEventBriefsTable(): Promise<boolean> {
    try {
      const res = await this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='event_briefs'")
        .first<{ name: string }>();
      return !!res;
    } catch (_err) {
      return false;
    }
  }

  async getLatestEventBrief(eventId: number): Promise<EventBriefRow | null> {
    try {
      return await this.db
        .prepare('SELECT * FROM event_briefs WHERE event_id = ?1 ORDER BY version DESC, id DESC LIMIT 1')
        .bind(eventId)
        .first<EventBriefRow>();
    } catch (_err) {
      // Table may not exist yet if migration pending
      return null;
    }
  }

  async getEventBriefByFingerprint(eventId: number, fingerprint: string): Promise<EventBriefRow | null> {
    try {
      return await this.db
        .prepare('SELECT * FROM event_briefs WHERE event_id = ?1 AND article_fingerprint = ?2 ORDER BY version DESC, id DESC LIMIT 1')
        .bind(eventId, fingerprint)
        .first<EventBriefRow>();
    } catch (_err) {
      return null;
    }
  }

  async acquireEventBriefLease(params: {
    event_id: number;
    article_fingerprint: string;
    article_ids: string;
    source_count: number;
    article_count: number;
    model?: string;
    version: number;
    leaseTimeoutSeconds?: number;
  }): Promise<EventBriefRow | null> {
    const now = Math.floor(Date.now() / 1000);
    const timeout = params.leaseTimeoutSeconds ?? 300;
    try {
      return await this.db
        .prepare(
          `INSERT INTO event_briefs (
             event_id, content, article_fingerprint, article_ids, source_count, article_count,
             model, version, status, error_message, created_at, updated_at
           )
           VALUES (?1, '{}', ?2, ?3, ?4, ?5, ?6, ?7, 'generating', NULL, ?8, ?8)
           ON CONFLICT(event_id, article_fingerprint) DO UPDATE SET
             status = 'generating',
             updated_at = ?8,
             model = excluded.model,
             version = excluded.version
           WHERE (event_briefs.status = 'failed')
              OR (event_briefs.status = 'generating' AND event_briefs.updated_at < ?8 - ?9)
           RETURNING *`
        )
        .bind(
          params.event_id,
          params.article_fingerprint,
          params.article_ids,
          params.source_count,
          params.article_count,
          params.model || 'gemini-3.6-flash',
          params.version,
          now,
          timeout
        )
        .first<EventBriefRow>();
    } catch (_err) {
      return null;
    }
  }

  async saveEventBrief(brief: Omit<EventBriefRow, 'id' | 'created_at' | 'updated_at'>): Promise<EventBriefRow> {
    const now = Math.floor(Date.now() / 1000);
    const result = await this.db
      .prepare(
        `INSERT INTO event_briefs (
           event_id, content, article_fingerprint, article_ids, source_count, article_count,
           model, version, status, error_message, created_at, updated_at
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(event_id, article_fingerprint) DO UPDATE SET
           content = excluded.content,
           article_ids = excluded.article_ids,
           source_count = excluded.source_count,
           article_count = excluded.article_count,
           model = excluded.model,
           version = excluded.version,
           status = excluded.status,
           error_message = excluded.error_message,
           updated_at = excluded.updated_at
         WHERE event_briefs.status != 'completed' OR excluded.status = 'completed'
         RETURNING *`
      )
      .bind(
        brief.event_id,
        brief.content,
        brief.article_fingerprint,
        brief.article_ids,
        brief.source_count,
        brief.article_count,
        brief.model,
        brief.version,
        brief.status,
        brief.error_message ?? null,
        now,
        now
      )
      .first<EventBriefRow>();

    if (!result) {
      const existing = await this.getEventBriefByFingerprint(brief.event_id, brief.article_fingerprint);
      if (existing) return existing;
      throw new Error('Failed to save event brief');
    }
    return result;
  }

  // ─── Phase 10: Event Narrative Deltas (What Changed) ───────
  async hasNarrativeDeltasTable(): Promise<boolean> {
    try {
      const res = await this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='event_narrative_deltas'")
        .first<{ name: string }>();
      return !!res;
    } catch (_err) {
      return false;
    }
  }

  async getNarrativeDelta(eventId: number, currentVersion: number): Promise<EventNarrativeDeltaRow | null> {
    try {
      return await this.db
        .prepare('SELECT * FROM event_narrative_deltas WHERE event_id = ?1 AND current_version = ?2 ORDER BY id DESC LIMIT 1')
        .bind(eventId, currentVersion)
        .first<EventNarrativeDeltaRow>();
    } catch (_err) {
      return null;
    }
  }

  async getLatestNarrativeDelta(eventId: number): Promise<EventNarrativeDeltaRow | null> {
    try {
      return await this.db
        .prepare('SELECT * FROM event_narrative_deltas WHERE event_id = ?1 ORDER BY current_version DESC, id DESC LIMIT 1')
        .bind(eventId)
        .first<EventNarrativeDeltaRow>();
    } catch (_err) {
      return null;
    }
  }

  async acquireNarrativeDeltaLease(params: {
    event_id: number;
    previous_version: number;
    current_version: number;
    article_fingerprint: string;
    model?: string;
    leaseTimeoutSeconds?: number;
  }): Promise<EventNarrativeDeltaRow | null> {
    const now = Math.floor(Date.now() / 1000);
    const timeout = params.leaseTimeoutSeconds ?? 300;
    try {
      return await this.db
        .prepare(
          `INSERT INTO event_narrative_deltas (
             event_id, previous_version, current_version, content, article_fingerprint,
             model, status, error_message, created_at, updated_at
           )
           VALUES (?1, ?2, ?3, '{}', ?4, ?5, 'generating', NULL, ?6, ?6)
           ON CONFLICT(event_id, previous_version, current_version) DO UPDATE SET
             status = 'generating',
             updated_at = ?6,
             article_fingerprint = excluded.article_fingerprint,
             model = excluded.model
           WHERE (event_narrative_deltas.status = 'failed')
              OR (event_narrative_deltas.status = 'generating' AND event_narrative_deltas.updated_at < ?6 - ?7)
           RETURNING *`
        )
        .bind(
          params.event_id,
          params.previous_version,
          params.current_version,
          params.article_fingerprint,
          params.model || 'gemini-3.6-flash',
          now,
          timeout
        )
        .first<EventNarrativeDeltaRow>();
    } catch (_err) {
      return null;
    }
  }

  async saveNarrativeDelta(delta: Omit<EventNarrativeDeltaRow, 'id' | 'created_at' | 'updated_at'>): Promise<EventNarrativeDeltaRow> {
    const now = Math.floor(Date.now() / 1000);
    const result = await this.db
      .prepare(
        `INSERT INTO event_narrative_deltas (
           event_id, previous_version, current_version, content, article_fingerprint,
           model, status, error_message, created_at, updated_at
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(event_id, previous_version, current_version) DO UPDATE SET
           content = excluded.content,
           article_fingerprint = excluded.article_fingerprint,
           model = excluded.model,
           status = excluded.status,
           error_message = excluded.error_message,
           updated_at = excluded.updated_at
         WHERE event_narrative_deltas.status != 'completed' OR excluded.status = 'completed'
         RETURNING *`
      )
      .bind(
        delta.event_id,
        delta.previous_version,
        delta.current_version,
        delta.content,
        delta.article_fingerprint,
        delta.model,
        delta.status,
        delta.error_message ?? null,
        now,
        now
      )
      .first<EventNarrativeDeltaRow>();

    if (!result) {
      const existing = await this.getNarrativeDelta(delta.event_id, delta.current_version);
      if (existing) return existing;
      throw new Error('Failed to save event narrative delta');
    }
    return result;
  }

  // ─── Phase 10: Event Claim Comparisons (Cross-Source) ──────
  async hasClaimComparisonsTable(): Promise<boolean> {
    try {
      const res = await this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='event_claim_comparisons'")
        .first<{ name: string }>();
      return !!res;
    } catch (_err) {
      return false;
    }
  }

  async getClaimComparisons(eventId: number, version: number): Promise<EventClaimComparisonRow | null> {
    try {
      return await this.db
        .prepare('SELECT * FROM event_claim_comparisons WHERE event_id = ?1 AND version = ?2 ORDER BY id DESC LIMIT 1')
        .bind(eventId, version)
        .first<EventClaimComparisonRow>();
    } catch (_err) {
      return null;
    }
  }

  async getLatestClaimComparisons(eventId: number): Promise<EventClaimComparisonRow | null> {
    try {
      return await this.db
        .prepare('SELECT * FROM event_claim_comparisons WHERE event_id = ?1 ORDER BY version DESC, id DESC LIMIT 1')
        .bind(eventId)
        .first<EventClaimComparisonRow>();
    } catch (_err) {
      return null;
    }
  }

  async acquireClaimComparisonsLease(params: {
    event_id: number;
    version: number;
    article_fingerprint: string;
    model?: string;
    leaseTimeoutSeconds?: number;
  }): Promise<EventClaimComparisonRow | null> {
    const now = Math.floor(Date.now() / 1000);
    const timeout = params.leaseTimeoutSeconds ?? 300;
    try {
      return await this.db
        .prepare(
          `INSERT INTO event_claim_comparisons (
             event_id, version, content, article_fingerprint,
             model, status, error_message, created_at, updated_at
           )
           VALUES (?1, ?2, '[]', ?3, ?4, 'generating', NULL, ?5, ?5)
           ON CONFLICT(event_id, version) DO UPDATE SET
             status = 'generating',
             updated_at = ?5,
             article_fingerprint = excluded.article_fingerprint,
             model = excluded.model
           WHERE (event_claim_comparisons.status = 'failed')
              OR (event_claim_comparisons.status = 'generating' AND event_claim_comparisons.updated_at < ?5 - ?6)
           RETURNING *`
        )
        .bind(
          params.event_id,
          params.version,
          params.article_fingerprint,
          params.model || 'gemini-3.6-flash',
          now,
          timeout
        )
        .first<EventClaimComparisonRow>();
    } catch (_err) {
      return null;
    }
  }

  async saveClaimComparisons(comp: Omit<EventClaimComparisonRow, 'id' | 'created_at' | 'updated_at'>): Promise<EventClaimComparisonRow> {
    const now = Math.floor(Date.now() / 1000);
    const result = await this.db
      .prepare(
        `INSERT INTO event_claim_comparisons (
           event_id, version, content, article_fingerprint,
           model, status, error_message, created_at, updated_at
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(event_id, version) DO UPDATE SET
           content = excluded.content,
           article_fingerprint = excluded.article_fingerprint,
           model = excluded.model,
           status = excluded.status,
           error_message = excluded.error_message,
           updated_at = excluded.updated_at
         WHERE event_claim_comparisons.status != 'completed' OR excluded.status = 'completed'
         RETURNING *`
      )
      .bind(
        comp.event_id,
        comp.version,
        comp.content,
        comp.article_fingerprint,
        comp.model,
        comp.status,
        comp.error_message ?? null,
        now,
        now
      )
      .first<EventClaimComparisonRow>();

    if (!result) {
      const existing = await this.getClaimComparisons(comp.event_id, comp.version);
      if (existing) return existing;
      throw new Error('Failed to save event claim comparisons');
    }
    return result;
  }
}

export function createDbClient(env: Env): DbClient {
  return new DbClient(env.DB);
}
