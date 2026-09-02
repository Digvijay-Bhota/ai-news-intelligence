/**
 * Request Router — Phase 0 (Canonical)
 *
 * PUBLIC:
 *   GET  /api/v1/health
 *   GET  /api/v1/feed
 *   GET  /api/v1/preferences
 *   POST /api/v1/preferences
 *   GET  /api/v1/saved
 *   POST /api/v1/saved
 *   DELETE /api/v1/saved/:id
 *   POST /api/v1/hide
 *
 * INTERNAL:
 *   POST /internal/v1/articles
 *   POST /internal/v1/events
 *   POST /internal/v1/ai-jobs
 *   POST /internal/v1/pipeline-log
 */

import type { Env, ApiResponse, ArticleRaw, FeedItem } from './types';
import { NotFoundError, BadRequestError } from './utils/errors';
import { authenticate, authenticateInternal, requireScopes } from './middleware/auth';
import { applyPublicRateLimit, applyInternalRateLimit, rateLimitHeaders } from './middleware/rate-limit';
import { applyCors, handleCorsPreflight } from './middleware/cors';
import { parseBody } from './middleware/body-limit';
import { createDbClient } from './db/client';
import { withCache, generateCacheKey } from './utils/cache';
import { requireString, optionalString, optionalNumber } from './middleware/validate';

// ─── Response Helpers ─────────────────────────────────────

function json<T>(data: ApiResponse<T>, status = 200, extraHeaders?: Record<string, string>): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders };
  return new Response(JSON.stringify(data), { status, headers });
}

function success<T>(data: T, status = 200, extraHeaders?: Record<string, string>): Response {
  return json({ success: true, data }, status, extraHeaders);
}

function error(message: string, status = 400, extraHeaders?: Record<string, string>): Response {
  return json({ success: false, error: message }, status, extraHeaders);
}

// ─── Helpers ──────────────────────────────────────────────

async function buildFeedItemsBatch(db: ReturnType<typeof createDbClient>, articles: ArticleRaw[]): Promise<FeedItem[]> {
  if (articles.length === 0) return [];
  const articleIds = articles.map(a => a.id);
  const sourceIds = articles.map(a => a.source_id);

  const [intelligenceMap, sourcesMap] = await Promise.all([
    db.getIntelligenceBatch(articleIds),
    db.getSourcesBatch(sourceIds)
  ]);

  return articles.map(article => {
    const intelligence = intelligenceMap.get(article.id) ?? { topics: [], events: [] };
    return {
      id: article.id,
      external_id: article.external_id,
      title: article.title,
      summary: article.summary,
      url: article.url,
      source: sourcesMap.get(article.source_id) ?? 'unknown',
      published_at: article.published_at,
      category: null,
      topics: intelligence.topics,
      events: intelligence.events,
    };
  });
}

// ─── Public Handlers ──────────────────────────────────────

async function handleHealth(_request: Request, env: Env): Promise<Response> {
  return success({
    status: 'healthy',
    version: '0.1.0-phase0',
    timestamp: Math.floor(Date.now() / 1000),
    environment: env.ENVIRONMENT ?? 'unknown',
  });
}
async function handleGetArticleDetail(_request: Request, env: Env, id: number): Promise<Response> {
  const cacheKey = generateCacheKey('article_detail', { id });

  const article = await withCache(
    cacheKey,
    () => createDbClient(env).getArticleDetailById(id),
    env,
    300 // Cache public article intelligence for 5 minutes
  );

  if (!article) {
    throw new NotFoundError('Article not found');
  }

  return success(article);
}

async function handleGetEvent(_request: Request, env: Env, hash: string): Promise<Response> {
  const cacheKey = generateCacheKey('event_detail', { hash });

  const eventDetail = await withCache(
    cacheKey,
    () => createDbClient(env).getEventDetailByHash(hash),
    env,
    300
  );

  if (!eventDetail) {
    throw new NotFoundError('Event not found');
  }

  const db = createDbClient(env);
  const items = await buildFeedItemsBatch(db, eventDetail.articles);

  const itemsWithEntities = items.map((item, index) => {
    let entities;
    const raw = eventDetail.articles[index].extracted_entities;
    if (raw) {
      try {
        entities = JSON.parse(raw);
      } catch (e) {}
    }
    return {
      ...item,
      ...(entities ? { extracted_entities: entities } : {})
    };
  });

  return success({
    event: eventDetail.event,
    coverage: eventDetail.coverage,
    articles: itemsWithEntities
  });
}

async function handleFeed(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10), 100);
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
  const sourceId = url.searchParams.get('source_id');
  const q = url.searchParams.get('q');
  const topic = url.searchParams.get('topic');
  const topicsParam = url.searchParams.get('topics');
  const sourceNamesParam = url.searchParams.get('source_names');

  const topics = topicsParam ? topicsParam.split(',').map(s => s.trim()).filter(Boolean) : undefined;
  const sourceNames = sourceNamesParam ? sourceNamesParam.split(',').map(s => s.trim()).filter(Boolean) : undefined;

  const cacheKey = generateCacheKey('feed', {
    limit,
    offset,
    sourceId: sourceId ?? undefined,
    q: q ?? undefined,
    topic: topic ?? undefined,
    topics: topics ? topics.join(',') : undefined,
    sourceNames: sourceNames ? sourceNames.join(',') : undefined
  });

  const result = await withCache(
    cacheKey,
    () => createDbClient(env).listArticles({
      limit, offset,
      source_id: sourceId ? parseInt(sourceId, 10) : undefined,
      source_names: sourceNames,
      q: q ? q.slice(0, 100) : undefined, // Safe truncation
      topic_slug: topic ? topic.slice(0, 100) : undefined,
      topics,
      status: 'processed',
    }),
    env,
    60
  );

  const db = createDbClient(env);
  const items = await buildFeedItemsBatch(db, result.articles);

  return success({
    meta: {
      limit,
      offset,
      total: result.total,
    },
    items,
  });
}

async function handleGetTopics(_request: Request, env: Env): Promise<Response> {
  const cacheKey = generateCacheKey('topics', {});
  const topics = await withCache(
    cacheKey,
    () => createDbClient(env).listTopics(),
    env,
    300
  );
  return success(topics);
}

async function handleGetSources(_request: Request, env: Env): Promise<Response> {
  const cacheKey = generateCacheKey('sources', {});
  const sources = await withCache(
    cacheKey,
    () => createDbClient(env).listSources(),
    env,
    300
  );
  return success(sources);
}

async function handleGetPreferences(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const userId = url.searchParams.get('user_id');
  if (!userId) throw new BadRequestError('user_id required');

  const db = createDbClient(env);
  const prefs = await db.getUserPreferences(userId);
  if (!prefs) {
    return success({
      user_id: userId,
      preferred_topics: [],
      preferred_sources: [],
      digest_frequency: 'daily',
      email: null,
    });
  }

  return success({
    user_id: prefs.user_id,
    preferred_topics: prefs.preferred_topics ? JSON.parse(prefs.preferred_topics) : [],
    preferred_sources: prefs.preferred_sources ? JSON.parse(prefs.preferred_sources) : [],
    digest_frequency: prefs.digest_frequency,
    email: prefs.email,
  });
}

async function handlePostPreferences(request: Request, env: Env): Promise<Response> {
  const body = await parseBody<{
    user_id: string;
    preferred_topics?: string[];
    preferred_sources?: string[];
    digest_frequency?: string;
    email?: string;
  }>(request, false, env);

  const userId = requireString(body.user_id, 'user_id');

  const db = createDbClient(env);
  const prefs = await db.upsertUserPreferences({
    user_id: userId,
    preferred_topics: body.preferred_topics ? JSON.stringify(body.preferred_topics) : null,
    preferred_sources: body.preferred_sources ? JSON.stringify(body.preferred_sources) : null,
    digest_frequency: body.digest_frequency ?? 'daily',
    email: body.email ?? null,
  });

  return success({
    user_id: prefs.user_id,
    preferred_topics: prefs.preferred_topics ? JSON.parse(prefs.preferred_topics) : [],
    preferred_sources: prefs.preferred_sources ? JSON.parse(prefs.preferred_sources) : [],
    digest_frequency: prefs.digest_frequency,
    email: prefs.email,
  });
}

async function handleGetSaved(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const userId = url.searchParams.get('user_id');
  if (!userId) throw new BadRequestError('user_id required');

  const db = createDbClient(env);
  const saved = await db.listSavedArticles(userId);
  return success(saved);
}

async function handlePostSaved(request: Request, env: Env): Promise<Response> {
  const body = await parseBody<{
    user_id: string;
    article_raw_id: number;
    note?: string;
  }>(request, false, env);

  const userId = requireString(body.user_id, 'user_id');
  const articleRawId = requireString(String(body.article_raw_id), 'article_raw_id');

  const db = createDbClient(env);
  const saved = await db.createSavedArticle(userId, parseInt(articleRawId, 10), body.note);
  return success(saved, 201);
}

async function handleDeleteSaved(request: Request, env: Env, id: number): Promise<Response> {
  const url = new URL(request.url);
  const userId = url.searchParams.get('user_id');
  if (!userId) throw new BadRequestError('user_id required');

  const db = createDbClient(env);
  const deleted = await db.deleteSavedArticle(id, userId);
  if (!deleted) throw new NotFoundError('Saved article not found');
  return success({ deleted: true });
}

async function handleHide(request: Request, env: Env): Promise<Response> {
  const body = await parseBody<{
    user_id: string;
    article_raw_id: number;
    reason?: string;
  }>(request, false, env);

  const userId = requireString(body.user_id, 'user_id');
  const articleRawId = requireString(String(body.article_raw_id), 'article_raw_id');

  const db = createDbClient(env);
  const hidden = await db.createHiddenStory(userId, parseInt(articleRawId, 10), body.reason);
  return success(hidden, 201);
}

// ─── Internal Handlers ────────────────────────────────────

async function handleInternalArticles(request: Request, env: Env): Promise<Response> {
  const body = await parseBody<{
    external_id: string;
    source_id: number;
    title: string;
    summary?: string;
    url: string;
    raw_content?: string;
    published_at?: number;
    language?: string;
  }>(request, true, env);

  const db = createDbClient(env);
  const existing = await db.getArticleByExternalId(body.external_id);
  if (existing) {
    throw new BadRequestError('Article with this external_id already exists');
  }

  const article = await db.createArticle({
    external_id: requireString(body.external_id, 'external_id'),
    source_id: requireString(String(body.source_id), 'source_id') as unknown as number,
    title: requireString(body.title, 'title'),
    summary: optionalString(body.summary) ?? null,
    url: requireString(body.url, 'url'),
    raw_content: optionalString(body.raw_content) ?? null,
    published_at: optionalNumber(body.published_at) ?? null,
    language: optionalString(body.language) ?? 'en',
    status: 'pending',
  });

  return success(article, 201);
}

async function handleInternalEvents(request: Request, env: Env): Promise<Response> {
  const body = await parseBody<{
    event_hash: string;
    title: string;
    description?: string;
    severity?: string;
    started_at?: number;
  }>(request, true, env);

  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.prepare(
    `INSERT INTO events (event_hash, title, description, severity, started_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(event_hash) DO UPDATE SET
       title = excluded.title,
       description = excluded.description,
       severity = excluded.severity
     RETURNING *`
  )
    .bind(
      requireString(body.event_hash, 'event_hash'),
      requireString(body.title, 'title'),
      optionalString(body.description) ?? null,
      optionalString(body.severity) ?? 'info',
      optionalNumber(body.started_at) ?? now,
      now
    )
    .first();

  return success(result, 201);
}

async function handleInternalAiJobs(request: Request, env: Env): Promise<Response> {
  const body = await parseBody<{
    article_raw_id?: number;
    job_type: string;
    model?: string;
  }>(request, true, env);

  const db = createDbClient(env);
  const job = await db.createAiJob({
    article_raw_id: optionalNumber(body.article_raw_id) ?? null,
    job_type: requireString(body.job_type, 'job_type'),
    model: optionalString(body.model) ?? null,
    status: 'queued',
  });

  return success(job, 201);
}

async function handleInternalPipelineLog(request: Request, env: Env): Promise<Response> {
  const body = await parseBody<{
    job_type: string;
    status: string;
    payload?: string;
    result?: string;
    error_message?: string;
  }>(request, true, env);

  const db = createDbClient(env);
  const job = await db.createPipelineJob({
    job_type: requireString(body.job_type, 'job_type'),
    status: requireString(body.status, 'status'),
    payload: body.payload ? JSON.stringify(body.payload) : null,
    result: body.result ? JSON.stringify(body.result) : null,
    error_message: optionalString(body.error_message) ?? null,
  });

  return success(job, 201);
}

// ─── Router ───────────────────────────────────────────────

export async function route(request: Request, env: Env): Promise<Response> {
  const preflight = handleCorsPreflight(request, env);
  if (preflight) return preflight;

  const url = new URL(request.url);
  const path = url.pathname;

  try {
    let response: Response;

    // Health (no auth)
    if (path === '/api/v1/health' && request.method === 'GET') {
      const rateInfo = await applyPublicRateLimit(request, '/api/v1/health', env);
      response = await handleHealth(request, env);
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    const articleMatch = path.match(/^\/api\/v1\/articles\/(\d+)$/);
    if (articleMatch && request.method === 'GET') {
      const rateInfo = await applyPublicRateLimit(request, '/api/v1/articles/:id', env);
      response = await handleGetArticleDetail(request, env, parseInt(articleMatch[1], 10));
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    const eventMatch = path.match(/^\/api\/v1\/events\/([a-zA-Z0-9_-]+)$/);
    if (eventMatch && request.method === 'GET') {
      const rateInfo = await applyPublicRateLimit(request, '/api/v1/events/:hash', env);
      response = await handleGetEvent(request, env, eventMatch[1]);
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    // Public API
    if (path === '/api/v1/feed' && request.method === 'GET') {
      await authenticate(request, env, false);
      const rateInfo = await applyPublicRateLimit(request, '/api/v1/feed', env);
      response = await handleFeed(request, env);
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    if (path === '/api/v1/topics' && request.method === 'GET') {
      const rateInfo = await applyPublicRateLimit(request, '/api/v1/topics', env);
      response = await handleGetTopics(request, env);
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    if (path === '/api/v1/sources' && request.method === 'GET') {
      const rateInfo = await applyPublicRateLimit(request, '/api/v1/sources', env);
      response = await handleGetSources(request, env);
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    if (path === '/api/v1/preferences' && request.method === 'GET') {
      await authenticate(request, env, false);
      const rateInfo = await applyPublicRateLimit(request, '/api/v1/preferences', env);
      response = await handleGetPreferences(request, env);
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    if (path === '/api/v1/preferences' && request.method === 'POST') {
      await authenticate(request, env, false);
      const rateInfo = await applyPublicRateLimit(request, '/api/v1/preferences', env);
      response = await handlePostPreferences(request, env);
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    if (path === '/api/v1/saved' && request.method === 'GET') {
      await authenticate(request, env, false);
      const rateInfo = await applyPublicRateLimit(request, '/api/v1/saved', env);
      response = await handleGetSaved(request, env);
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    if (path === '/api/v1/saved' && request.method === 'POST') {
      await authenticate(request, env, false);
      const rateInfo = await applyPublicRateLimit(request, '/api/v1/saved', env);
      response = await handlePostSaved(request, env);
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    const savedMatch = path.match(/^\/api\/v1\/saved\/(\d+)$/);
    if (savedMatch && request.method === 'DELETE') {
      await authenticate(request, env, false);
      const rateInfo = await applyPublicRateLimit(request, '/api/v1/saved/:id', env);
      response = await handleDeleteSaved(request, env, parseInt(savedMatch[1], 10));
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    if (path === '/api/v1/hide' && request.method === 'POST') {
      await authenticate(request, env, false);
      const rateInfo = await applyPublicRateLimit(request, '/api/v1/hide', env);
      response = await handleHide(request, env);
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    // Internal API
    if (path === '/internal/v1/articles' && request.method === 'POST') {
      const auth = await authenticateInternal(request, env);
      requireScopes(auth, ['internal', 'admin']);
      const rateInfo = await applyInternalRateLimit(auth.identifier, '/internal/v1/articles', env);
      response = await handleInternalArticles(request, env);
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    if (path === '/internal/v1/events' && request.method === 'POST') {
      const auth = await authenticateInternal(request, env);
      requireScopes(auth, ['internal', 'admin']);
      const rateInfo = await applyInternalRateLimit(auth.identifier, '/internal/v1/events', env);
      response = await handleInternalEvents(request, env);
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    if (path === '/internal/v1/ai-jobs' && request.method === 'POST') {
      const auth = await authenticateInternal(request, env);
      requireScopes(auth, ['internal', 'admin']);
      const rateInfo = await applyInternalRateLimit(auth.identifier, '/internal/v1/ai-jobs', env);
      response = await handleInternalAiJobs(request, env);
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    if (path === '/internal/v1/pipeline-log' && request.method === 'POST') {
      const auth = await authenticateInternal(request, env);
      requireScopes(auth, ['internal', 'admin']);
      const rateInfo = await applyInternalRateLimit(auth.identifier, '/internal/v1/pipeline-log', env);
      response = await handleInternalPipelineLog(request, env);
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    throw new NotFoundError('Endpoint not found');
  } catch (err) {
    const status = err instanceof Error && 'status' in err ? (err as { status: number }).status : 500;
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    const response = error(message, status);
    return applyCors(request, response, env);
  }
}
