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

import { getEventFreshness } from "./utils/freshness";
import type {
  Env, ApiResponse, ArticleRaw, FeedItem, EventBrief, EventBriefMetadata, ChangeSummary,
  NarrativeDelta, NarrativeDeltaMetadata, ClaimComparison, ClaimComparisonMetadata,
  FollowTargetType
} from './types';
import { NotFoundError, BadRequestError, ForbiddenError } from './utils/errors';
import { authenticate, authenticateInternal, requireScopes, requireAuthenticatedUser, AuthContext } from './middleware/auth';
import { applyPublicRateLimit, applyInternalRateLimit, rateLimitHeaders } from './middleware/rate-limit';
import { applyCors, handleCorsPreflight } from './middleware/cors';
import { parseBody } from './middleware/body-limit';
import { createDbClient } from './db/client';
import { withCache, generateCacheKey } from './utils/cache';
import { requireString, optionalString, optionalNumber } from './middleware/validate';
import { computeArticleFingerprint, generateAndSaveEventBrief } from './tasks/brief-generator';
import { generateAndSaveNarrativeDelta } from './tasks/narrative-delta-generator';
import { generateAndSaveClaimComparisons } from './tasks/claim-comparison-generator';

// ─── Response Helpers ─────────────────────────────────────

function json<T>(data: ApiResponse<T>, status = 200, extraHeaders?: Record<string, string>): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders };
  return new Response(JSON.stringify(data), { status, headers });
}

function success<T>(data: T, status = 200, extraHeaders?: Record<string, string>): Response {
  return json({ success: true, data }, status, extraHeaders);
}

function error(message: string, status = 400, extraHeaders?: Record<string, string>): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders };
  return new Response(JSON.stringify({ success: false, error: message }), { status, headers });
}

// @ts-ignore: Intentionally preserved per contract but currently unused
function internalError(err: unknown, extraHeaders?: Record<string, string>): Response {
  console.error('Internal Server Error:', err);
  return error('Internal Server Error', 500, extraHeaders);
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
    version: env.VERSION ?? '0.8.0',
    timestamp: Math.floor(Date.now() / 1000),
    environment: env.ENVIRONMENT ?? 'development',
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


async function handleGetEvents(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const freshness = url.searchParams.get('freshness');
  const severity = url.searchParams.get('severity');
  const min_articles_str = url.searchParams.get('min_articles');
  const sort = url.searchParams.get('sort');

  if (freshness && !['developing', 'active', 'stale'].includes(freshness)) {
    throw new BadRequestError('Invalid freshness filter');
  }
  if (severity && !['critical', 'high', 'warning', 'medium', 'info', 'low'].includes(severity)) {
    throw new BadRequestError('Invalid severity filter');
  }
  if (sort && !['priority', 'recent', 'coverage'].includes(sort)) {
    throw new BadRequestError('Invalid sort parameter');
  }

  let min_articles = 0;
  if (min_articles_str) {
    if (!/^\d+$/.test(min_articles_str)) {
      throw new BadRequestError('min_articles must be a non-negative integer');
    }
    min_articles = parseInt(min_articles_str, 10);
    if (!Number.isSafeInteger(min_articles)) {
      throw new BadRequestError('min_articles is too large');
    }
  }

  const cacheKey = generateCacheKey('active_events', {
    freshness: freshness ?? undefined,
    severity: severity ?? undefined,
    min_articles: min_articles || undefined, // use undefined if 0 to keep clean URL
    sort: sort ?? undefined
  });
  const now = Math.floor(Date.now() / 1000);

  const result = await withCache(
    cacheKey,
    async () => {
      const dbResult = await createDbClient(env).getActiveEvents(now, {
        freshness: freshness ?? undefined,
        severity: severity ?? undefined,
        min_articles,
        sort: sort ?? undefined
      });
      return {
        items: dbResult.items.map(e => ({
          ...e,
          freshness: getEventFreshness(e.last_published_at, e.article_count, now)
        })),
        summary: dbResult.summary
      };
    },
    env,
    300
  );

  return success(result);
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

  const now = Math.floor(Date.now() / 1000);
  const db = createDbClient(env);
  const items = await buildFeedItemsBatch(db, eventDetail.articles);

  // Accumulate unique topics while parsing extracted_entities for articles.
  // This is a single pass — no additional DB queries.
  const seenTopics = new Set<string>();
  const itemsWithEntities = items.map((item, index) => {
    let entities: { topics?: string[]; events?: { title: string; description: string; severity: string }[] } | undefined;
    const raw = eventDetail.articles[index].extracted_entities;
    if (raw) {
      try {
        entities = JSON.parse(raw);
      } catch (_e) {}
    }
    if (entities?.topics) {
      for (const t of entities.topics) {
        if (typeof t === 'string' && t.trim()) {
          seenTopics.add(t.trim());
        }
      }
    }
    return {
      ...item,
      ...(entities ? { extracted_entities: entities } : {})
    };
  });

  // Freshness: post-cache, uses coverage.last_published_at (MAX(a.published_at))
  const freshness = getEventFreshness(
    eventDetail.coverage.last_published_at,
    eventDetail.coverage.total_articles,
    now
  );

  // Intelligence: all derived from already-fetched data, zero additional queries.
  const unique_topics = Array.from(seenTopics).sort();
  const { first_published_at, last_published_at, total_articles, sources } = eventDetail.coverage;

  let days_active: number | null = null;
  let coverage_density: number | null = null;
  if (first_published_at !== null && last_published_at !== null) {
    days_active = Math.max(1, Math.ceil((last_published_at - first_published_at) / 86400));
    coverage_density = Math.round((total_articles / days_active) * 10) / 10;
  }

  const top_source: string | null = sources.length > 0
    ? sources.reduce((best, s) => s.article_count > best.article_count ? s : best, sources[0]).name
    : null;

  const intelligence = {
    topic_count: unique_topics.length,
    unique_topics,
    days_active,
    coverage_density,
    top_source,
  };

  // Phase 9 & 10: Grounded AI Event Brief, Narrative Delta & Cross-Source Intelligence
  let brief: EventBrief | null = null;
  let brief_metadata: EventBriefMetadata | null = null;
  let narrative_delta: NarrativeDelta | null = null;
  let narrative_delta_metadata: NarrativeDeltaMetadata | null = null;
  let claim_comparisons: ClaimComparison[] = [];
  let claim_comparison_metadata: ClaimComparisonMetadata | null = null;
  let change_summary: ChangeSummary | null = null;

  if (eventDetail.event.id) {
    try {
      const latestBrief = await db.getLatestEventBrief(eventDetail.event.id);
      const currentFingerprint = await computeArticleFingerprint(
        eventDetail.event.id,
        eventDetail.articles
      );

      if (latestBrief && latestBrief.status === 'completed') {
        try {
          brief = JSON.parse(latestBrief.content) as EventBrief;
          const is_stale = latestBrief.article_fingerprint !== currentFingerprint;
          const unincorporated_article_count = Math.max(0, eventDetail.coverage.total_articles - latestBrief.article_count);

          brief_metadata = {
            version: latestBrief.version,
            status: 'completed',
            generated_at: latestBrief.created_at,
            model: latestBrief.model,
            article_fingerprint: latestBrief.article_fingerprint,
            article_count: latestBrief.article_count,
            source_count: latestBrief.source_count,
            is_stale,
            unincorporated_article_count,
          };

          change_summary = {
            has_changed: is_stale,
            article_delta: eventDetail.coverage.total_articles - latestBrief.article_count,
            source_delta: eventDetail.coverage.total_sources - latestBrief.source_count,
            latest_activity_at: eventDetail.coverage.last_published_at,
          };

          // Phase 10: Narrative Delta (only for Version >= 2)
          if (latestBrief.version >= 2) {
            try {
              const deltaRow = await db.getNarrativeDelta(eventDetail.event.id, latestBrief.version);
              if (deltaRow && deltaRow.status === 'completed') {
                narrative_delta = JSON.parse(deltaRow.content) as NarrativeDelta;
                narrative_delta_metadata = {
                  previous_version: deltaRow.previous_version,
                  current_version: deltaRow.current_version,
                  status: 'completed',
                  model: deltaRow.model,
                  generated_at: deltaRow.created_at,
                  article_fingerprint: deltaRow.article_fingerprint,
                };
              } else if (deltaRow) {
                narrative_delta_metadata = {
                  previous_version: deltaRow.previous_version,
                  current_version: deltaRow.current_version,
                  status: deltaRow.status,
                  model: deltaRow.model,
                  generated_at: deltaRow.created_at,
                  article_fingerprint: deltaRow.article_fingerprint,
                };
              }
            } catch (_deltaErr) {
              narrative_delta = null;
            }
          }

          // Phase 10: Claim Comparisons
          try {
            const compRow = await db.getClaimComparisons(eventDetail.event.id, latestBrief.version);
            if (compRow && compRow.status === 'completed') {
              claim_comparisons = JSON.parse(compRow.content) as ClaimComparison[];
              claim_comparison_metadata = {
                version: compRow.version,
                status: 'completed',
                model: compRow.model,
                generated_at: compRow.created_at,
                claim_count: claim_comparisons.length,
                article_fingerprint: compRow.article_fingerprint,
              };
            } else if (compRow) {
              claim_comparison_metadata = {
                version: compRow.version,
                status: compRow.status,
                model: compRow.model,
                generated_at: compRow.created_at,
                claim_count: 0,
                article_fingerprint: compRow.article_fingerprint,
              };
            }
          } catch (_compErr) {
            claim_comparisons = [];
          }
        } catch (_parseErr) {
          brief = null;
        }
      } else if (latestBrief) {
        brief_metadata = {
          version: latestBrief.version,
          status: latestBrief.status as 'generating' | 'failed',
          generated_at: latestBrief.created_at,
          model: latestBrief.model,
          article_fingerprint: latestBrief.article_fingerprint,
          article_count: latestBrief.article_count,
          source_count: latestBrief.source_count,
          is_stale: false,
          unincorporated_article_count: 0,
        };
      }
    } catch (_briefErr) {
      // Graceful degradation if tables do not exist or query fails
    }
  }

  return success({
    event: {
      ...eventDetail.event,
      freshness,
      last_published_at: eventDetail.coverage.last_published_at,
    },
    coverage: eventDetail.coverage,
    intelligence,
    brief,
    brief_metadata,
    narrative_delta,
    narrative_delta_metadata,
    claim_comparisons,
    claim_comparison_metadata,
    change_summary,
    articles: itemsWithEntities,
  });
}

async function handleGenerateEventBrief(_request: Request, env: Env, hash: string): Promise<Response> {
  const db = createDbClient(env);
  const eventDetail = await db.getEventDetailByHash(hash);
  if (!eventDetail || !eventDetail.event.id) {
    throw new NotFoundError('Event not found');
  }

  const previousBrief = await db.getLatestEventBrief(eventDetail.event.id);

  const briefRow = await generateAndSaveEventBrief(
    env,
    {
      id: eventDetail.event.id,
      hash,
      title: eventDetail.event.title,
      description: eventDetail.event.description,
      severity: eventDetail.event.severity,
    },
    eventDetail.articles
  );

  // Generate Narrative Delta if Version >= 2 and previous brief completed
  if (previousBrief && previousBrief.status === 'completed' && previousBrief.version < briefRow.version) {
    await generateAndSaveNarrativeDelta(
      env,
      {
        id: eventDetail.event.id,
        hash,
        title: eventDetail.event.title,
        description: eventDetail.event.description,
        severity: eventDetail.event.severity,
      },
      previousBrief,
      briefRow,
      eventDetail.articles
    ).catch(() => null);
  }

  // Generate Cross-Source Claim Comparisons
  await generateAndSaveClaimComparisons(
    env,
    {
      id: eventDetail.event.id,
      hash,
      title: eventDetail.event.title,
      description: eventDetail.event.description,
      severity: eventDetail.event.severity,
    },
    briefRow,
    eventDetail.articles
  ).catch(() => null);

  // Invalidate cached event detail
  const cacheKey = generateCacheKey('event_detail', { hash });
  try {
    await env.CACHE?.delete(cacheKey);
  } catch (_e) {}

  const parsedBrief = JSON.parse(briefRow.content);
  return success({
    brief: parsedBrief,
    brief_metadata: {
      version: briefRow.version,
      status: briefRow.status,
      generated_at: briefRow.created_at,
      model: briefRow.model,
      article_fingerprint: briefRow.article_fingerprint,
      article_count: briefRow.article_count,
      source_count: briefRow.source_count,
      is_stale: false,
      unincorporated_article_count: 0,
    }
  }, 200);
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
    async () => {
      const db = createDbClient(env);
      const res = await db.listArticles({
        limit, offset,
        source_id: sourceId ? parseInt(sourceId, 10) : undefined,
        source_names: sourceNames,
        q: q ? q.slice(0, 100) : undefined, // Safe truncation
        topic_slug: topic ? topic.slice(0, 100) : undefined,
        topics,
        status: 'processed',
      });
      const items = await buildFeedItemsBatch(db, res.articles);
      return { total: res.total, items };
    },
    env,
    60
  );

  return success({
    meta: {
      limit,
      offset,
      total: result.total,
    },
    items: result.items,
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

const PRIVATE_NO_CACHE_HEADERS: Record<string, string> = {
  'Cache-Control': 'private, no-cache, no-store, must-revalidate',
  Vary: 'Cookie, X-Authenticated-User-Id',
};

async function handleGetPreferences(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const userId = requireAuthenticatedUser(auth);
  const url = new URL(request.url);
  const clientUserId = url.searchParams.get('user_id');
  if (clientUserId && clientUserId !== userId) throw new ForbiddenError('User ID mismatch');

  const db = createDbClient(env);
  await db.getOrCreateUser(userId);
  const prefs = await db.getUserPreferences(userId);
  if (!prefs) {
    return success({
      user_id: userId,
      preferred_topics: [],
      preferred_sources: [],
      digest_frequency: 'daily',
      email: null,
    }, 200, PRIVATE_NO_CACHE_HEADERS);
  }

  return success({
    user_id: prefs.user_id,
    preferred_topics: prefs.preferred_topics ? JSON.parse(prefs.preferred_topics) : [],
    preferred_sources: prefs.preferred_sources ? JSON.parse(prefs.preferred_sources) : [],
    digest_frequency: prefs.digest_frequency,
    email: prefs.email,
  }, 200, PRIVATE_NO_CACHE_HEADERS);
}

async function handlePostPreferences(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const userId = requireAuthenticatedUser(auth);
  const body = await parseBody<{
    user_id?: string;
    preferred_topics?: string[];
    preferred_sources?: string[];
    digest_frequency?: string;
    email?: string;
  }>(request, false, env);

  if (body.user_id && body.user_id !== userId) throw new ForbiddenError('User ID mismatch');

  const db = createDbClient(env);
  await db.getOrCreateUser(userId);
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
  }, 200, PRIVATE_NO_CACHE_HEADERS);
}

async function handleGetSaved(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const userId = requireAuthenticatedUser(auth);
  const url = new URL(request.url);
  const clientUserId = url.searchParams.get('user_id');
  if (clientUserId && clientUserId !== userId) throw new ForbiddenError('User ID mismatch');

  const db = createDbClient(env);
  await db.getOrCreateUser(userId);
  const saved = await db.listSavedArticles(userId);
  return success(saved, 200, PRIVATE_NO_CACHE_HEADERS);
}

async function handlePostSaved(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const userId = requireAuthenticatedUser(auth);
  const body = await parseBody<{
    user_id?: string;
    article_raw_id: number;
    note?: string;
  }>(request, false, env);

  if (body.user_id && body.user_id !== userId) throw new ForbiddenError('User ID mismatch');

  const articleRawId = requireString(String(body.article_raw_id), 'article_raw_id');

  const db = createDbClient(env);
  await db.getOrCreateUser(userId);
  const saved = await db.createSavedArticle(userId, parseInt(articleRawId, 10), body.note);
  return success(saved, 201, PRIVATE_NO_CACHE_HEADERS);
}

async function handleDeleteSaved(request: Request, env: Env, auth: AuthContext, id: number): Promise<Response> {
  const userId = requireAuthenticatedUser(auth);
  const url = new URL(request.url);
  const clientUserId = url.searchParams.get('user_id');
  if (clientUserId && clientUserId !== userId) throw new ForbiddenError('User ID mismatch');

  const db = createDbClient(env);
  await db.getOrCreateUser(userId);
  const deleted = await db.deleteSavedArticle(id, userId);
  if (!deleted) throw new NotFoundError('Saved article not found');
  return success({ deleted: true }, 200, PRIVATE_NO_CACHE_HEADERS);
}

async function handleHide(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const userId = requireAuthenticatedUser(auth);
  const body = await parseBody<{
    user_id?: string;
    article_raw_id: number;
    reason?: string;
  }>(request, false, env);

  if (body.user_id && body.user_id !== userId) throw new ForbiddenError('User ID mismatch');

  const articleRawId = requireString(String(body.article_raw_id), 'article_raw_id');

  const db = createDbClient(env);
  await db.getOrCreateUser(userId);
  const hidden = await db.createHiddenStory(userId, parseInt(articleRawId, 10), body.reason);
  return success(hidden, 201, PRIVATE_NO_CACHE_HEADERS);
}

async function handlePersonalizedFeed(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const userId = requireAuthenticatedUser(auth);
  const url = new URL(request.url);
  const clientUserId = url.searchParams.get('user_id');
  if (clientUserId && clientUserId !== userId) {
    throw new ForbiddenError('User ID mismatch');
  }

  const limitParam = url.searchParams.get('limit');
  const offsetParam = url.searchParams.get('offset');

  let limit = 20;
  if (limitParam !== null) {
    if (!/^\d+$/.test(limitParam)) {
      throw new BadRequestError('limit must be a positive integer');
    }
    limit = parseInt(limitParam, 10);
    if (limit < 1 || limit > 50) {
      throw new BadRequestError('limit must be between 1 and 50');
    }
  }

  let offset = 0;
  if (offsetParam !== null) {
    if (!/^\d+$/.test(offsetParam)) {
      throw new BadRequestError('offset must be a non-negative integer');
    }
    offset = parseInt(offsetParam, 10);
    if (offset < 0 || !Number.isSafeInteger(offset)) {
      throw new BadRequestError('offset is invalid');
    }
  }

  const db = createDbClient(env);
  await db.getOrCreateUser(userId);
  const now = Math.floor(Date.now() / 1000);
  const result = await db.getPersonalizedFeedEvents(userId, now, { limit, offset });

  return success(result, 200, PRIVATE_NO_CACHE_HEADERS);
}

async function handleSinceLastSeenFeed(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const userId = requireAuthenticatedUser(auth);
  const url = new URL(request.url);
  const clientUserId = url.searchParams.get('user_id');
  if (clientUserId && clientUserId !== userId) {
    throw new ForbiddenError('User ID mismatch');
  }

  const limitParam = url.searchParams.get('limit');
  const offsetParam = url.searchParams.get('offset');

  let limit = 20;
  if (limitParam !== null) {
    if (!/^\d+$/.test(limitParam)) {
      throw new BadRequestError('limit must be a positive integer');
    }
    limit = parseInt(limitParam, 10);
    if (limit < 1 || limit > 50) {
      throw new BadRequestError('limit must be between 1 and 50');
    }
  }

  let offset = 0;
  if (offsetParam !== null) {
    if (!/^\d+$/.test(offsetParam)) {
      throw new BadRequestError('offset must be a non-negative integer');
    }
    offset = parseInt(offsetParam, 10);
    if (offset < 0 || !Number.isSafeInteger(offset)) {
      throw new BadRequestError('offset is invalid');
    }
  }

  const db = createDbClient(env);
  const now = Math.floor(Date.now() / 1000);
  const result = await db.getSinceLastSeenEvents(userId, now, { limit, offset });

  return success(result, 200, PRIVATE_NO_CACHE_HEADERS);
}

async function handleAckSeen(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const userId = requireAuthenticatedUser(auth);
  let body: Record<string, unknown> = {};
  try {
    body = await parseBody<Record<string, unknown>>(request, false, env);
  } catch {
    // Empty body is valid and standard for ack-seen
  }

  if (body.user_id && body.user_id !== userId) {
    throw new ForbiddenError('User ID mismatch');
  }

  const db = createDbClient(env);
  const acknowledged_through = await db.markFeedCaughtUp(userId);

  return success({ acknowledged_through }, 200, PRIVATE_NO_CACHE_HEADERS);
}

async function handleReadEvent(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const userId = requireAuthenticatedUser(auth);
  const body = await parseBody<{
    user_id?: string;
    event_id?: number | string;
    event_hash?: string;
  }>(request, false, env);

  if (body.user_id && body.user_id !== userId) {
    throw new ForbiddenError('User ID mismatch');
  }

  let eventId: number | undefined;
  const db = createDbClient(env);

  if (body.event_id !== undefined) {
    const parsed = typeof body.event_id === 'number' ? body.event_id : parseInt(String(body.event_id), 10);
    if (isNaN(parsed) || parsed <= 0) {
      throw new BadRequestError('event_id must be a positive integer');
    }
    eventId = parsed;
  } else if (body.event_hash) {
    const hash = requireString(body.event_hash, 'event_hash').trim();
    const event = await db.getEventByHash(hash);
    if (!event) {
      throw new NotFoundError(`Event not found: ${hash}`);
    }
    eventId = event.id;
  } else {
    throw new BadRequestError('event_id or event_hash is required');
  }

  const result = await db.markEventRead(userId, eventId);
  return success(result, 200, PRIVATE_NO_CACHE_HEADERS);
}

async function handleGetFollows(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const userId = requireAuthenticatedUser(auth);
  const url = new URL(request.url);
  const clientUserId = url.searchParams.get('user_id');
  if (clientUserId && clientUserId !== userId) throw new ForbiddenError('User ID mismatch');

  const targetTypeParam = url.searchParams.get('target_type');
  let targetType: FollowTargetType | undefined;
  if (targetTypeParam) {
    if (targetTypeParam !== 'topic' && targetTypeParam !== 'event' && targetTypeParam !== 'source') {
      throw new BadRequestError("Invalid target_type. Must be 'topic', 'event', or 'source'");
    }
    targetType = targetTypeParam as FollowTargetType;
  }

  const db = createDbClient(env);
  await db.getOrCreateUser(userId);
  const follows = await db.listUserFollows(userId, targetType);
  return success(follows, 200, PRIVATE_NO_CACHE_HEADERS);
}

async function handlePostFollow(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const userId = requireAuthenticatedUser(auth);
  const body = await parseBody<{
    user_id?: string;
    target_type: string;
    target_id: string;
  }>(request, false, env);

  if (body.user_id && body.user_id !== userId) {
    throw new ForbiddenError('User ID mismatch');
  }

  const targetType = requireString(body.target_type, 'target_type');
  const targetId = requireString(body.target_id, 'target_id').trim();

  if (targetType !== 'topic' && targetType !== 'event' && targetType !== 'source') {
    throw new BadRequestError("Invalid target_type. Must be 'topic', 'event', or 'source'");
  }

  if (!targetId) {
    throw new BadRequestError('target_id must not be empty');
  }

  const db = createDbClient(env);

  // Canonical target validation
  if (targetType === 'topic') {
    const topic = await db.getTopicBySlug(targetId);
    if (!topic) {
      throw new NotFoundError(`Topic not found: ${targetId}`);
    }
  } else if (targetType === 'event') {
    const event = await db.getEventByHash(targetId);
    if (!event) {
      throw new NotFoundError(`Event not found: ${targetId}`);
    }
  } else if (targetType === 'source') {
    const source = await db.getSourceByName(targetId);
    if (!source) {
      const numericId = parseInt(targetId, 10);
      const sourceById = !isNaN(numericId) ? await db.getSourceById(numericId) : null;
      if (!sourceById) {
        throw new NotFoundError(`Source not found: ${targetId}`);
      }
    }
  }

  await db.getOrCreateUser(userId);
  const follow = await db.createUserFollow(userId, targetType as FollowTargetType, targetId);
  return success(follow, 201, PRIVATE_NO_CACHE_HEADERS);
}

async function handleDeleteFollow(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const userId = requireAuthenticatedUser(auth);
  const url = new URL(request.url);

  let targetType = url.searchParams.get('target_type');
  let targetId = url.searchParams.get('target_id');
  const clientUserId = url.searchParams.get('user_id');
  if (clientUserId && clientUserId !== userId) {
    throw new ForbiddenError('User ID mismatch');
  }

  if (!targetType || !targetId) {
    try {
      const body = await parseBody<{
        user_id?: string;
        target_type?: string;
        target_id?: string;
      }>(request, false, env);
      if (body.user_id && body.user_id !== userId) {
        throw new ForbiddenError('User ID mismatch');
      }
      if (!targetType && body.target_type) targetType = body.target_type;
      if (!targetId && body.target_id) targetId = body.target_id;
    } catch {
      // Body may not exist for DELETE request
    }
  }

  if (!targetType || (targetType !== 'topic' && targetType !== 'event' && targetType !== 'source')) {
    throw new BadRequestError("Invalid or missing target_type. Must be 'topic', 'event', or 'source'");
  }

  if (!targetId || !targetId.trim()) {
    throw new BadRequestError('Missing target_id');
  }

  const db = createDbClient(env);
  await db.getOrCreateUser(userId);
  const deleted = await db.deleteUserFollow(userId, targetType as FollowTargetType, targetId.trim());
  return success({ deleted, target_type: targetType, target_id: targetId.trim() }, 200, PRIVATE_NO_CACHE_HEADERS);
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

// ─── Community Identity (Phase 13A) ─────────────────────

async function handleGetCommunityProfile(_request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const db = createDbClient(env);
  const userId = requireAuthenticatedUser(auth);

  let profile = await db.getUserProfile(userId);

  if (!profile) {
    // Ensure the durable anonymous user exists first
    await db.getOrCreateUser(userId);

    // Lazy creation
    const publicId = crypto.randomUUID().replace(/-/g, '').substring(0, 21); // basic non-enumerable id
    const shortHash = publicId.substring(0, 4).toUpperCase();
    const displayName = `Reader_${shortHash}`;

    try {
      profile = await db.createUserProfile({
        user_id: userId,
        public_id: publicId,
        display_name: displayName,
        status: 'active'
      });
    } catch (err: any) {
      if (err.message?.includes('UNIQUE') || err.message?.includes('constraint failed') || err.message?.includes('SQLITE_CONSTRAINT')) {
        const existing = await db.getUserProfile(userId);
        if (existing) {
          profile = existing;
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }
  }

  // Never expose user_id
  return success({
    public_id: profile.public_id,
    display_name: profile.display_name,
    status: profile.status,
    created_at: profile.created_at
  });
}

async function handlePatchCommunityProfile(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const db = createDbClient(env);
  const userId = requireAuthenticatedUser(auth);
  const body = await parseBody<{ display_name?: string }>(request, true, env);

  let displayName = optionalString(body.display_name);
  if (!displayName) {
    throw new BadRequestError('Display name is required');
  }

  displayName = displayName.trim();

  if (displayName.length < 3 || displayName.length > 30) {
    throw new BadRequestError('Display name must be between 3 and 30 characters');
  }

  const nameRegex = /^[\p{L}\p{M}\p{N} \-_]+$/u;
  if (!nameRegex.test(displayName)) {
    throw new BadRequestError('Display name contains invalid characters');
  }

  const updated = await db.updateUserProfile(userId, displayName);
  if (!updated) {
     throw new NotFoundError('Profile not found');
  }

  return success({
    public_id: updated.public_id,
    display_name: updated.display_name,
    status: updated.status,
    created_at: updated.created_at
  });
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


    if (path === '/api/v1/events' && request.method === 'GET') {
      const rateInfo = await applyPublicRateLimit(request, '/api/v1/events', env);
      response = await handleGetEvents(request, env);
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    const eventMatch = path.match(/^\/api\/v1\/events\/([a-zA-Z0-9_-]+)$/);
    if (eventMatch && request.method === 'GET') {
      const rateInfo = await applyPublicRateLimit(request, '/api/v1/events/:hash', env);
      response = await handleGetEvent(request, env, eventMatch[1]);
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    // Public API
    if (path === '/api/v1/feed/for-you' && request.method === 'GET') {
      const auth = await authenticate(request, env, false);
      const rateInfo = await applyPublicRateLimit(request, '/api/v1/feed/for-you', env);
      response = await handlePersonalizedFeed(request, env, auth);
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    if (path === '/api/v1/feed/since-last-seen' && request.method === 'GET') {
      const auth = await authenticate(request, env, false);
      const rateInfo = await applyPublicRateLimit(request, '/api/v1/feed/since-last-seen', env);
      response = await handleSinceLastSeenFeed(request, env, auth);
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    if (path === '/api/v1/feed/ack-seen' && request.method === 'POST') {
      const auth = await authenticate(request, env, false);
      const rateInfo = await applyPublicRateLimit(request, '/api/v1/feed/ack-seen', env);
      response = await handleAckSeen(request, env, auth);
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    if (path === '/api/v1/feed/read-event' && request.method === 'POST') {
      const auth = await authenticate(request, env, false);
      const rateInfo = await applyPublicRateLimit(request, '/api/v1/feed/read-event', env);
      response = await handleReadEvent(request, env, auth);
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

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
      const auth = await authenticate(request, env, false);
      const rateInfo = await applyPublicRateLimit(request, '/api/v1/preferences', env);
      response = await handleGetPreferences(request, env, auth);
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    if (path === '/api/v1/preferences' && request.method === 'POST') {
      const auth = await authenticate(request, env, false);
      const rateInfo = await applyPublicRateLimit(request, '/api/v1/preferences', env);
      response = await handlePostPreferences(request, env, auth);
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    if (path === '/api/v1/saved' && request.method === 'GET') {
      const auth = await authenticate(request, env, false);
      const rateInfo = await applyPublicRateLimit(request, '/api/v1/saved', env);
      response = await handleGetSaved(request, env, auth);
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    if (path === '/api/v1/saved' && request.method === 'POST') {
      const auth = await authenticate(request, env, false);
      const rateInfo = await applyPublicRateLimit(request, '/api/v1/saved', env);
      response = await handlePostSaved(request, env, auth);
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    const savedMatch = path.match(/^\/api\/v1\/saved\/(\d+)$/);
    if (savedMatch && request.method === 'DELETE') {
      const auth = await authenticate(request, env, false);
      const rateInfo = await applyPublicRateLimit(request, '/api/v1/saved/:id', env);
      response = await handleDeleteSaved(request, env, auth, parseInt(savedMatch[1], 10));
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    if (path === '/api/v1/hide' && request.method === 'POST') {
      const auth = await authenticate(request, env, false);
      const rateInfo = await applyPublicRateLimit(request, '/api/v1/hide', env);
      response = await handleHide(request, env, auth);
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    if (path === '/api/v1/follows' && request.method === 'GET') {
      const auth = await authenticate(request, env, false);
      const rateInfo = await applyPublicRateLimit(request, '/api/v1/follows', env);
      response = await handleGetFollows(request, env, auth);
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    if (path === '/api/v1/follows' && request.method === 'POST') {
      const auth = await authenticate(request, env, false);
      const rateInfo = await applyPublicRateLimit(request, '/api/v1/follows', env);
      response = await handlePostFollow(request, env, auth);
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    if (path === '/api/v1/follows' && request.method === 'DELETE') {
      const auth = await authenticate(request, env, false);
      const rateInfo = await applyPublicRateLimit(request, '/api/v1/follows', env);
      response = await handleDeleteFollow(request, env, auth);
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    if (path === '/api/v1/community/profile' && request.method === 'GET') {
      const auth = await authenticate(request, env, false);
      const rateInfo = await applyPublicRateLimit(request, '/api/v1/community/profile', env);
      response = await handleGetCommunityProfile(request, env, auth);
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    if (path === '/api/v1/community/profile' && request.method === 'PATCH') {
      const auth = await authenticate(request, env, false);
      const rateInfo = await applyPublicRateLimit(request, '/api/v1/community/profile', env);
      response = await handlePatchCommunityProfile(request, env, auth);
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

    const internalBriefMatch = path.match(/^\/internal\/v1\/events\/([a-zA-Z0-9_-]+)\/brief$/);
    if (internalBriefMatch && request.method === 'POST') {
      const auth = await authenticateInternal(request, env);
      requireScopes(auth, ['internal', 'admin']);
      const rateInfo = await applyInternalRateLimit(auth.identifier, '/internal/v1/events/:hash/brief', env);
      response = await handleGenerateEventBrief(request, env, internalBriefMatch[1]);
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    const apiBriefMatch = path.match(/^\/api\/v1\/events\/([a-zA-Z0-9_-]+)\/brief$/);
    if (apiBriefMatch && request.method === 'POST') {
      const auth = await authenticateInternal(request, env);
      requireScopes(auth, ['internal', 'admin']);
      const rateInfo = await applyInternalRateLimit(auth.identifier, '/api/v1/events/:hash/brief', env);
      response = await handleGenerateEventBrief(request, env, apiBriefMatch[1]);
      return applyCors(request, response, env, rateLimitHeaders(rateInfo));
    }

    throw new NotFoundError('Endpoint not found');
  } catch (err) {
    const status = err instanceof Error && 'status' in err ? (err as { status: number }).status : 500;
    const message = (err instanceof Error && status !== 500) ? err.message : 'Internal Server Error';
    const response = error(message, status);
    return applyCors(request, response, env);
  }
}
