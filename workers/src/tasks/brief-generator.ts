/**
 * Grounded AI Event Briefing & Change Detection Engine
 */

import type { Env, ArticleRaw, EventBrief, EventBriefRow } from '../types';
import { createDbClient } from '../db/client';
import { generateEventBriefFromGemini } from './gemini';
import { retryWithBackoff } from './processor';

/**
 * Computes a deterministic SHA-256 fingerprint representing the exact article set and state of an event.
 * Includes article ID, publication timestamp, source ID, normalized title, and a bounded content signal.
 */
export async function computeArticleFingerprint(
  eventId: number | string,
  articles: {
    id: number;
    published_at: number | null;
    source_id: number;
    title: string;
    summary?: string | null;
    raw_content?: string | null;
  }[]
): Promise<string> {
  // 1. Sort articles deterministically by ID
  const sorted = [...articles].sort((a, b) => a.id - b.id);

  // 2. Format canonical string representation with bounded content signal (first 300 chars of summary or content)
  const canonicalArticles = sorted
    .map(a => {
      const contentSnippet = (a.summary || a.raw_content || '').trim().slice(0, 300).toLowerCase();
      return `${a.id}:${a.published_at ?? 0}:${a.source_id}:${a.title.trim().toLowerCase()}:${contentSnippet}`;
    })
    .join('|');

  const payload = `${eventId}|${canonicalArticles}`;

  // 3. Compute SHA-256 hash
  const encoder = new TextEncoder();
  const data = encoder.encode(payload);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Validates the structured output of the Gemini event briefing synthesis.
 * Enforces structural provenance grounding by ensuring every cited article ID
 * exists within the event's actual article set, all claim contexts are non-empty,
 * and duplicate citations are deduplicated.
 *
 * NOTE: This validates structural reference integrity and schema compliance;
 * it does not perform semantic natural language entailment verification.
 */
export function validateEventBrief(
  raw: unknown,
  validArticleIds: Set<number>
): asserts raw is EventBrief {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid brief structure: expected a JSON object');
  }

  const data = raw as Record<string, unknown>;

  // 1. Summary
  if (typeof data.summary !== 'string' || data.summary.trim().length < 20 || data.summary.length > 2500) {
    throw new Error('Invalid brief structure: summary must be a string between 20 and 2500 characters');
  }

  // 2. Why It Matters
  if (typeof data.why_it_matters !== 'string' || data.why_it_matters.trim().length < 10 || data.why_it_matters.length > 1500) {
    throw new Error('Invalid brief structure: why_it_matters must be a string between 10 and 1500 characters');
  }

  // 3. Key Developments
  if (!Array.isArray(data.key_developments) || data.key_developments.length === 0 || data.key_developments.length > 12) {
    throw new Error('Invalid brief structure: key_developments must be an array of 1 to 12 items');
  }
  for (const dev of data.key_developments) {
    if (typeof dev !== 'string' || dev.trim().length === 0 || dev.length > 600) {
      throw new Error('Invalid brief structure: each key development must be a string between 1 and 600 characters');
    }
  }

  // 4. Key Entities
  if (!Array.isArray(data.key_entities) || data.key_entities.length > 20) {
    throw new Error('Invalid brief structure: key_entities must be an array of at most 20 items');
  }
  for (const entity of data.key_entities) {
    if (!entity || typeof entity !== 'object') {
      throw new Error('Invalid brief structure: entity must be an object');
    }
    const e = entity as Record<string, unknown>;
    if (typeof e.name !== 'string' || !e.name.trim() || e.name.length > 100) {
      throw new Error('Invalid brief structure: entity name must be a string between 1 and 100 characters');
    }
    if (typeof e.type !== 'string' || !e.type.trim() || e.type.length > 50) {
      throw new Error('Invalid brief structure: entity type must be a string between 1 and 50 characters');
    }
    if (typeof e.relevance !== 'string' || !e.relevance.trim() || e.relevance.length > 300) {
      throw new Error('Invalid brief structure: entity relevance must be a string between 1 and 300 characters');
    }
  }

  // 5. Uncertainties
  if (!Array.isArray(data.uncertainties) || data.uncertainties.length > 10) {
    throw new Error('Invalid brief structure: uncertainties must be an array of at most 10 items');
  }
  for (const unc of data.uncertainties) {
    if (typeof unc !== 'string' || unc.trim().length === 0 || unc.length > 600) {
      throw new Error('Invalid brief structure: each uncertainty must be a string between 1 and 600 characters');
    }
  }

  // 6. Source References & Grounding Validation
  if (!Array.isArray(data.source_references) || data.source_references.length === 0 || data.source_references.length > 30) {
    throw new Error('Invalid brief structure: source_references must be an array of 1 to 30 items');
  }

  const seenRefs = new Set<string>();
  const deduplicatedRefs = [];

  for (const ref of data.source_references) {
    if (!ref || typeof ref !== 'object') {
      throw new Error('Invalid brief structure: source reference must be an object');
    }
    const r = ref as Record<string, unknown>;
    const articleId = typeof r.article_id === 'number' ? r.article_id : parseInt(String(r.article_id), 10);

    if (isNaN(articleId)) {
      throw new Error('Invalid brief structure: source reference article_id must be a valid number');
    }

    // STRICT PROVENANCE GROUNDING: article_id MUST be one of the event's actual articles!
    if (!validArticleIds.has(articleId)) {
      throw new Error(
        `Grounding violation: source reference article_id ${articleId} is not in the event article set`
      );
    }

    if (typeof r.claim_context !== 'string' || r.claim_context.trim().length === 0 || r.claim_context.length > 500) {
      throw new Error('Invalid brief structure: claim_context must be a string between 1 and 500 characters');
    }

    const key = `${articleId}:${r.claim_context.trim()}`;
    if (!seenRefs.has(key)) {
      seenRefs.add(key);
      deduplicatedRefs.push({
        article_id: articleId,
        claim_context: r.claim_context.trim(),
      });
    }
  }

  // Assign cleaned & verified references
  data.source_references = deduplicatedRefs;
}

/**
 * Generates and durably persists an AI Event Brief with provenance and fingerprint tracking.
 */
export async function generateAndSaveEventBrief(
  env: Env,
  event: { id: number; hash: string; title: string; description: string | null; severity: string },
  articles: (ArticleRaw & { source?: string })[]
): Promise<EventBriefRow> {
  if (articles.length === 0) {
    throw new Error('Cannot generate brief for an event with no articles');
  }

  const db = createDbClient(env);

  // 0. Pre-flight schema validation: do not attempt expensive synthesis if table not migrated
  const hasTable = await db.hasEventBriefsTable();
  if (!hasTable) {
    throw new Error('Database schema for event briefs is not yet migrated');
  }

  // 1. Calculate deterministic article fingerprint
  const fingerprint = await computeArticleFingerprint(event.id, articles);

  // 2. Check if a brief already exists for this exact fingerprint
  const existing = await db.getEventBriefByFingerprint(event.id, fingerprint);
  if (existing && existing.status === 'completed') {
    return existing;
  }

  // 3. Track AI job
  const aiJob = await db.createAiJob({
    article_raw_id: null,
    job_type: 'event_brief',
    model: 'gemini-3.6-flash',
    status: 'running',
  });

  const validArticleIds = new Set(articles.map(a => a.id));
  const distinctSources = new Set(articles.map(a => a.source_id));

  // Determine brief version number (reuse version on retry of existing fingerprint)
  const latestBrief = await db.getLatestEventBrief(event.id);
  const nextVersion = existing ? existing.version : (latestBrief ? latestBrief.version + 1 : 1);

  // 3b. Atomic generation lease to prevent duplicate external Gemini calls across workers
  const lease = await db.acquireEventBriefLease({
    event_id: event.id,
    article_fingerprint: fingerprint,
    article_ids: JSON.stringify(Array.from(validArticleIds)),
    source_count: distinctSources.size,
    article_count: articles.length,
    model: 'gemini-3.6-flash',
    version: nextVersion,
  });

  if (!lease) {
    if (existing && existing.status === 'completed') return existing;
    throw new Error(`Generation in progress: another worker holds active lease for event ${event.id}`);
  }

  try {
    // 4. Synthesize with Gemini
    const rawBrief = await retryWithBackoff(() =>
      generateEventBriefFromGemini(
        env,
        { title: event.title, description: event.description, severity: event.severity },
        articles.map(a => ({
          id: a.id,
          title: a.title,
          summary: a.summary,
          raw_content: a.raw_content,
          source: a.source || `Source #${a.source_id}`,
          published_at: a.published_at,
        }))
      )
    );

    // 5. Strictly validate output & verify grounding
    validateEventBrief(rawBrief, validArticleIds);

    // 6. Durably save brief
    const savedBrief = await db.saveEventBrief({
      event_id: event.id,
      content: JSON.stringify(rawBrief),
      article_fingerprint: fingerprint,
      article_ids: JSON.stringify(Array.from(validArticleIds)),
      source_count: distinctSources.size,
      article_count: articles.length,
      model: 'gemini-3.6-flash',
      version: nextVersion,
      status: 'completed',
      error_message: null,
    });

    await db.updateAiJobStatus(aiJob.id, 'completed', JSON.stringify({ brief_id: savedBrief.id, version: nextVersion }));
    return savedBrief;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error during event brief generation';
    await db.createAiLog(aiJob.id, errorMsg, 'error');
    await db.updateAiJobStatus(aiJob.id, 'failed', undefined, errorMsg);

    // Record failure status in event_briefs for provenance/observability if useful
    await db.saveEventBrief({
      event_id: event.id,
      content: JSON.stringify({ error: errorMsg }),
      article_fingerprint: fingerprint,
      article_ids: JSON.stringify(Array.from(validArticleIds)),
      source_count: distinctSources.size,
      article_count: articles.length,
      model: 'gemini-3.6-flash',
      version: nextVersion,
      status: 'failed',
      error_message: errorMsg,
    }).catch(() => {});

    throw error;
  }
}
