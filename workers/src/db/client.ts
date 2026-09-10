/**
 * D1 Database Access Layer — Phase 0 (Canonical)
 */

import type { Env, ArticleRaw, Source, Topic, Event, PipelineJob, AiJob, DedupHash, SourceHealth, User, UserFollow, FollowTargetType, UserPreference, SavedArticle, HiddenStory, PipelineToken, EventBriefRow, EventNarrativeDeltaRow, EventClaimComparisonRow } from '../types';

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

  // ─── Users (Durable Anonymous Identity — Phase 11A) ───────
  async getOrCreateUser(userId: string): Promise<User> {
    const now = Math.floor(Date.now() / 1000);
    const existing = await this.db
      .prepare('SELECT * FROM users WHERE id = ?1')
      .bind(userId)
      .first<User>();

    if (existing) {
      if (now - existing.last_active_at > 300) {
        await this.db
          .prepare('UPDATE users SET last_active_at = ?1 WHERE id = ?2')
          .bind(now, userId)
          .run();
      }
      return existing;
    }

    await this.db
      .prepare('INSERT OR IGNORE INTO users (id, created_at, last_active_at) VALUES (?1, ?2, ?2)')
      .bind(userId, now)
      .run();

    const user = await this.db
      .prepare('SELECT * FROM users WHERE id = ?1')
      .bind(userId)
      .first<User>();

    return user ?? { id: userId, created_at: now, last_active_at: now };
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
