/**
 * claim-comparison-generator.ts — Phase 10: Cross-Source Intelligence Engine
 *
 * Extracts discrete factual claims across newsrooms and analyzes consensus vs. disagreement.
 * Enforces strict provenance validation against valid article and source sets.
 */

import type { Env, ArticleRaw, ClaimComparison, EventClaimComparisonRow, EventBriefRow } from '../types';
import { createDbClient } from '../db/client';
import { generateClaimComparisonsFromGemini } from './gemini';
import { retryWithBackoff } from './processor';

const VALID_CLAIM_STATUSES = new Set(['consensus', 'disputed', 'unconfirmed', 'evolving']);

/**
 * Validates the structured output of the Gemini claim comparisons synthesis.
 * Enforces referential integrity by ensuring every cited article ID and source ID
 * belongs to the event's actual evidence set.
 */
export function validateClaimComparisons(
  raw: unknown,
  validArticleIds: Set<number>,
  validSourceIds: Set<number>
): asserts raw is ClaimComparison[] {
  if (!Array.isArray(raw)) {
    throw new Error('Invalid claim comparisons structure: expected an array');
  }

  if (raw.length > 15) {
    throw new Error('Invalid claim comparisons structure: maximum 15 claims allowed');
  }

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Record<string, unknown>;
    if (!item || typeof item !== 'object') {
      throw new Error(`Invalid claim comparison at index ${i}: expected object`);
    }

    // 1. Claim text
    if (typeof item.claim !== 'string' || item.claim.trim().length < 5 || item.claim.length > 500) {
      throw new Error(`Invalid claim at index ${i}: claim must be between 5 and 500 characters`);
    }

    // 2. Status
    if (typeof item.status !== 'string' || !item.status.trim()) {
      throw new Error(`Invalid claim status at index ${i}: status must be a non-empty string`);
    }
    const status = item.status.trim().toLowerCase();
    if (!VALID_CLAIM_STATUSES.has(status)) {
      throw new Error(
        `Invalid claim status at index ${i}: "${item.status}". Allowed values are: consensus, disputed, unconfirmed, evolving`
      );
    }
    item.status = status;

    // 3. Sources
    if (!Array.isArray(item.sources) || item.sources.length === 0) {
      throw new Error(`Invalid claim at index ${i}: sources must be a non-empty array`);
    }

    if (item.sources.length > 15) {
      throw new Error(`Invalid claim at index ${i}: maximum 15 sources allowed per claim`);
    }

    for (let s = 0; s < item.sources.length; s++) {
      const src = item.sources[s] as Record<string, unknown>;
      if (!src || typeof src !== 'object') {
        throw new Error(`Invalid source at claim[${i}].sources[${s}]`);
      }

      // Validate source_id
      const sourceId = typeof src.source_id === 'number' ? src.source_id : parseInt(String(src.source_id), 10);
      if (isNaN(sourceId) || (validSourceIds.size > 0 && !validSourceIds.has(sourceId))) {
        // If sourceId is not in validSourceIds, fallback to first valid source or throw
        if (validSourceIds.size > 0 && !validSourceIds.has(sourceId)) {
          throw new Error(`Referential violation: source_id ${sourceId} at claim[${i}] is not in the event source set`);
        }
      }
      src.source_id = sourceId;

      // Validate source_name
      if (typeof src.source_name !== 'string' || !src.source_name.trim() || src.source_name.length > 100) {
        throw new Error(`Invalid source_name at claim[${i}].sources[${s}]`);
      }

      // Validate position
      if (typeof src.position !== 'string' || !src.position.trim() || src.position.length > 500) {
        throw new Error(`Invalid position statement at claim[${i}].sources[${s}]`);
      }

      // Validate article_ids
      if (!Array.isArray(src.article_ids)) {
        src.article_ids = [];
      } else {
        const deduplicated = new Set<number>();
        for (const aId of src.article_ids) {
          const articleId = typeof aId === 'number' ? aId : parseInt(String(aId), 10);
          if (isNaN(articleId)) {
            throw new Error(`Invalid article_id at claim[${i}].sources[${s}]`);
          }
          if (!validArticleIds.has(articleId)) {
            throw new Error(
              `Grounding violation: article_id ${articleId} at claim[${i}].sources[${s}] is not in the event article set`
            );
          }
          deduplicated.add(articleId);
        }
        src.article_ids = Array.from(deduplicated);
      }
    }
  }
}

/**
 * Generates and durably persists Cross-Source Claim Comparisons for an event brief.
 */
export async function generateAndSaveClaimComparisons(
  env: Env,
  event: { id: number; hash: string; title: string; description: string | null; severity: string },
  briefRow: EventBriefRow,
  articles: (ArticleRaw & { source?: string })[]
): Promise<EventClaimComparisonRow | null> {
  if (articles.length === 0) {
    return null;
  }

  const db = createDbClient(env);
  const hasTable = await db.hasClaimComparisonsTable();
  if (!hasTable) {
    return null;
  }

  // Check if comparisons already exist for this brief version
  const existing = await db.getClaimComparisons(event.id, briefRow.version);
  if (existing && existing.status === 'completed') {
    return existing;
  }

  // Attempt atomic generation lease to prevent duplicate external Gemini calls across workers
  const lease = await db.acquireClaimComparisonsLease({
    event_id: event.id,
    version: briefRow.version,
    article_fingerprint: briefRow.article_fingerprint,
    model: 'gemini-3.6-flash',
  });

  if (!lease) {
    return existing;
  }

  const aiJob = await db.createAiJob({
    article_raw_id: null,
    job_type: 'event_claim_comparison',
    model: 'gemini-3.6-flash',
    status: 'running',
  });

  const validArticleIds = new Set(articles.map(a => a.id));
  const validSourceIds = new Set(articles.map(a => a.source_id));

  try {
    const rawComparisons = await retryWithBackoff(() =>
      generateClaimComparisonsFromGemini(
        env,
        { title: event.title, description: event.description, severity: event.severity },
        articles.map(a => ({
          id: a.id,
          source_id: a.source_id,
          title: a.title,
          summary: a.summary,
          raw_content: a.raw_content,
          source: a.source || `Source #${a.source_id}`,
          published_at: a.published_at,
        }))
      )
    );

    validateClaimComparisons(rawComparisons, validArticleIds, validSourceIds);

    const savedComp = await db.saveClaimComparisons({
      event_id: event.id,
      version: briefRow.version,
      content: JSON.stringify(rawComparisons),
      article_fingerprint: briefRow.article_fingerprint,
      model: 'gemini-3.6-flash',
      status: 'completed',
      error_message: null,
    });

    await db.updateAiJobStatus(aiJob.id, 'completed', JSON.stringify({ comp_id: savedComp.id, claims: rawComparisons.length }));
    return savedComp;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error during claim comparison generation';
    await db.createAiLog(aiJob.id, errorMsg, 'error');
    await db.updateAiJobStatus(aiJob.id, 'failed', undefined, errorMsg);

    await db.saveClaimComparisons({
      event_id: event.id,
      version: briefRow.version,
      content: JSON.stringify([]),
      article_fingerprint: briefRow.article_fingerprint,
      model: 'gemini-3.6-flash',
      status: 'failed',
      error_message: errorMsg,
    }).catch(() => {});

    // Non-fatal
    return null;
  }
}
