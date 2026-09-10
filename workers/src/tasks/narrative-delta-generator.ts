/**
 * narrative-delta-generator.ts — Phase 10: Narrative Evolution Engine
 *
 * Synthesizes the semantic delta between Event Brief Version N-1 and Version N.
 * Enforces strict grounding, schema validation, and provenance reference checking.
 */

import type { Env, ArticleRaw, NarrativeDelta, EventNarrativeDeltaRow, EventBrief, EventBriefRow } from '../types';
import { createDbClient } from '../db/client';
import { generateNarrativeDeltaFromGemini } from './gemini';
import { retryWithBackoff } from './processor';

const VALID_CHANGE_TYPES = new Set(['refined', 'expanded', 'contradicted', 'retracted', 'uncertain']);

/**
 * Validates the structured output of the Gemini narrative delta synthesis.
 * Enforces structural provenance grounding by ensuring every cited article ID
 * exists within the event's actual article set.
 */
export function validateNarrativeDelta(
  raw: unknown,
  validArticleIds: Set<number>,
  expectedPreviousVersion: number,
  expectedCurrentVersion: number
): asserts raw is NarrativeDelta {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid narrative delta structure: expected a JSON object');
  }

  const data = raw as Record<string, unknown>;

  // 1. Version bounds
  data.previous_version = expectedPreviousVersion;
  data.current_version = expectedCurrentVersion;

  // 2. Summary
  if (typeof data.summary !== 'string' || data.summary.trim().length < 15 || data.summary.length > 2000) {
    throw new Error('Invalid narrative delta structure: summary must be a string between 15 and 2000 characters');
  }

  // Helper for source references validation
  const validateSourceRefs = (refs: unknown, contextPath: string): number[] => {
    if (!Array.isArray(refs)) {
      return [];
    }
    const deduplicated = new Set<number>();
    for (const ref of refs) {
      const articleId = typeof ref === 'number' ? ref : parseInt(String(ref), 10);
      if (isNaN(articleId)) {
        throw new Error(`Invalid narrative delta structure: source reference in ${contextPath} must be a number`);
      }
      if (!validArticleIds.has(articleId)) {
        throw new Error(
          `Grounding violation in narrative delta: source reference article_id ${articleId} in ${contextPath} is not in the event article set`
        );
      }
      deduplicated.add(articleId);
    }
    return Array.from(deduplicated);
  };

  // 3. Newly confirmed facts
  if (!Array.isArray(data.newly_confirmed)) {
    data.newly_confirmed = [];
  } else {
    if (data.newly_confirmed.length > 20) {
      throw new Error('Invalid narrative delta structure: newly_confirmed must have at most 20 items');
    }
    for (let i = 0; i < data.newly_confirmed.length; i++) {
      const item = data.newly_confirmed[i] as Record<string, unknown>;
      if (!item || typeof item !== 'object') {
        throw new Error(`Invalid newly_confirmed item at index ${i}`);
      }
      if (typeof item.statement !== 'string' || !item.statement.trim() || item.statement.length > 600) {
        throw new Error(`Invalid newly_confirmed statement at index ${i}`);
      }
      item.source_references = validateSourceRefs(item.source_references, `newly_confirmed[${i}]`);
    }
  }

  // 4. Changed claims
  if (!Array.isArray(data.changed_claims)) {
    data.changed_claims = [];
  } else {
    if (data.changed_claims.length > 20) {
      throw new Error('Invalid narrative delta structure: changed_claims must have at most 20 items');
    }
    for (let i = 0; i < data.changed_claims.length; i++) {
      const item = data.changed_claims[i] as Record<string, unknown>;
      if (!item || typeof item !== 'object') {
        throw new Error(`Invalid changed_claims item at index ${i}`);
      }
      if (typeof item.previous_statement !== 'string' || !item.previous_statement.trim() || item.previous_statement.length > 600) {
        throw new Error(`Invalid changed_claims previous_statement at index ${i}`);
      }
      if (typeof item.current_statement !== 'string' || !item.current_statement.trim() || item.current_statement.length > 600) {
        throw new Error(`Invalid changed_claims current_statement at index ${i}`);
      }
      if (typeof item.change_type !== 'string' || !item.change_type.trim()) {
        throw new Error(`Invalid changed_claims change_type at index ${i}: change_type must be a non-empty string`);
      }
      const changeType = item.change_type.trim().toLowerCase();
      if (!VALID_CHANGE_TYPES.has(changeType)) {
        throw new Error(
          `Invalid changed_claims change_type at index ${i}: "${item.change_type}". Allowed values are: refined, expanded, contradicted, retracted, uncertain`
        );
      }
      item.change_type = changeType;
      item.source_references = validateSourceRefs(item.source_references, `changed_claims[${i}]`);
    }
  }

  // 5. Removed or no longer supported
  if (!Array.isArray(data.removed_or_no_longer_supported)) {
    data.removed_or_no_longer_supported = [];
  } else {
    if (data.removed_or_no_longer_supported.length > 20) {
      throw new Error('Invalid narrative delta structure: removed_or_no_longer_supported must have at most 20 items');
    }
    for (let i = 0; i < data.removed_or_no_longer_supported.length; i++) {
      const item = data.removed_or_no_longer_supported[i] as Record<string, unknown>;
      if (!item || typeof item !== 'object') {
        throw new Error(`Invalid removed_or_no_longer_supported item at index ${i}`);
      }
      if (typeof item.statement !== 'string' || !item.statement.trim() || item.statement.length > 600) {
        throw new Error(`Invalid removed_or_no_longer_supported statement at index ${i}`);
      }
      item.source_references = validateSourceRefs(item.source_references, `removed_or_no_longer_supported[${i}]`);
    }
  }

  // 6. Unchanged core
  if (!Array.isArray(data.unchanged_core)) {
    data.unchanged_core = [];
  } else {
    if (data.unchanged_core.length > 20) {
      throw new Error('Invalid narrative delta structure: unchanged_core must have at most 20 items');
    }
    for (const core of data.unchanged_core) {
      if (typeof core !== 'string' || !core.trim() || core.length > 600) {
        throw new Error('Invalid narrative delta structure: unchanged_core item must be string');
      }
    }
  }

  // 7. Open questions
  if (!Array.isArray(data.open_questions)) {
    data.open_questions = [];
  } else {
    if (data.open_questions.length > 15) {
      throw new Error('Invalid narrative delta structure: open_questions must have at most 15 items');
    }
    for (const q of data.open_questions) {
      if (typeof q !== 'string' || !q.trim() || q.length > 600) {
        throw new Error('Invalid narrative delta structure: open_questions item must be string');
      }
    }
  }
}

/**
 * Generates and durably persists a Narrative Evolution Delta between previous and current brief versions.
 */
export async function generateAndSaveNarrativeDelta(
  env: Env,
  event: { id: number; hash: string; title: string; description: string | null; severity: string },
  previousBriefRow: EventBriefRow,
  currentBriefRow: EventBriefRow,
  articles: (ArticleRaw & { source?: string })[]
): Promise<EventNarrativeDeltaRow | null> {
  // Only generate delta for Version >= 2
  if (currentBriefRow.version <= 1 || previousBriefRow.version >= currentBriefRow.version) {
    return null;
  }

  const db = createDbClient(env);
  const hasTable = await db.hasNarrativeDeltasTable();
  if (!hasTable) {
    return null;
  }

  // Check if delta already exists for this version pair
  const existing = await db.getNarrativeDelta(event.id, currentBriefRow.version);
  if (existing && existing.status === 'completed') {
    return existing;
  }

  // Attempt atomic generation lease to prevent duplicate external Gemini calls across workers
  const lease = await db.acquireNarrativeDeltaLease({
    event_id: event.id,
    previous_version: previousBriefRow.version,
    current_version: currentBriefRow.version,
    article_fingerprint: currentBriefRow.article_fingerprint,
    model: 'gemini-3.6-flash',
  });

  if (!lease) {
    return existing;
  }

  let previousBrief: EventBrief;
  try {
    previousBrief = JSON.parse(previousBriefRow.content) as EventBrief;
  } catch (_e) {
    return null;
  }

  const aiJob = await db.createAiJob({
    article_raw_id: null,
    job_type: 'event_narrative_delta',
    model: 'gemini-3.6-flash',
    status: 'running',
  });

  const validArticleIds = new Set(articles.map(a => a.id));

  try {
    const rawDelta = await retryWithBackoff(() =>
      generateNarrativeDeltaFromGemini(
        env,
        { title: event.title, description: event.description, severity: event.severity },
        previousBrief,
        previousBriefRow.version,
        currentBriefRow.version,
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

    validateNarrativeDelta(rawDelta, validArticleIds, previousBriefRow.version, currentBriefRow.version);

    const savedDelta = await db.saveNarrativeDelta({
      event_id: event.id,
      previous_version: previousBriefRow.version,
      current_version: currentBriefRow.version,
      content: JSON.stringify(rawDelta),
      article_fingerprint: currentBriefRow.article_fingerprint,
      model: 'gemini-3.6-flash',
      status: 'completed',
      error_message: null,
    });

    await db.updateAiJobStatus(aiJob.id, 'completed', JSON.stringify({ delta_id: savedDelta.id, versions: `${previousBriefRow.version}->${currentBriefRow.version}` }));
    return savedDelta;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error during narrative delta generation';
    await db.createAiLog(aiJob.id, errorMsg, 'error');
    await db.updateAiJobStatus(aiJob.id, 'failed', undefined, errorMsg);

    await db.saveNarrativeDelta({
      event_id: event.id,
      previous_version: previousBriefRow.version,
      current_version: currentBriefRow.version,
      content: JSON.stringify({ error: errorMsg }),
      article_fingerprint: currentBriefRow.article_fingerprint,
      model: 'gemini-3.6-flash',
      status: 'failed',
      error_message: errorMsg,
    }).catch(() => {});

    // Non-fatal: narrative delta failure must NEVER fail the parent event brief
    return null;
  }
}
