/**
 * Pipeline Orchestrator
 */

import type { Env } from '../types';
import { createDbClient } from '../db/client';
import { fetchAndIngest, hasFeedUrl } from './fetcher';
import { processArticle } from './processor';
import { computeArticleFingerprint, EventBriefLeaseHeldError, generateAndSaveEventBrief } from './brief-generator';
import { generateAndSaveNarrativeDelta } from './narrative-delta-generator';
import { generateAndSaveClaimComparisons } from './claim-comparison-generator';
import { generateCommunitySignalsForEvent } from './community-signal-generator';
import { GeminiDeferredError } from './model-router';

const MAX_SOURCES = 10;
const MAX_ARTICLES = 20;
// A scheduled run is capped at 15 minutes; a pipeline-run job still running
// after that never recorded its outcome.
const STALE_PIPELINE_JOB_SECONDS = 900;

/** Outcome of one source in a run. Counts are null when they are not known. */
export interface SourceRunSummary {
  id: number;
  name: string;
  outcome: 'healthy' | 'down' | 'unconfigured';
  parsed: number | null;
  inserted: number | null;
  newest_published_at: number | null;
  error: string | null;
}

export interface ProcessingCounts {
  attempted: number;
  succeeded: number;
  failed: number;
  /** No Gemini model was available; not a failure. */
  deferred: number;
}

/**
 * Stored as JSON in pipeline_jobs.result. Timestamps are Unix seconds. A stage
 * that never started is null; after a failure, `failed_stage` names the stage
 * that was running and its counts cover only the work done before it failed.
 */
export interface PipelineRunSummary {
  version: 1;
  started_at: number;
  completed_at: number | null;
  failed_stage: 'recovery' | 'ingestion' | 'processing' | 'retries' | null;
  stale_jobs_recovered: number | null;
  sources: SourceRunSummary[];
  processing: ProcessingCounts | null;
  stale_articles_recovered: number | null;
  retries: ProcessingCounts | null;
  briefs: {
    /** 'skipped': event_briefs is not migrated; 'errored': the stage stopped early. */
    state: 'ran' | 'skipped' | 'errored';
    events: number;
    generated: number;
    failed: number;
    deferred: number;
    /** Another worker was already generating the brief for this event state. */
    in_progress: number;
  } | null;
}

const ERROR_SUMMARY_LENGTH = 200;

function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : 'Unknown error').slice(0, ERROR_SUMMARY_LENGTH);
}

function emptyCounts(): ProcessingCounts {
  return { attempted: 0, succeeded: 0, failed: 0, deferred: 0 };
}

export async function runPipeline(env: Env): Promise<void> {
  const db = createDbClient(env);
  const summary: PipelineRunSummary = {
    version: 1,
    started_at: Math.floor(Date.now() / 1000),
    completed_at: null,
    failed_stage: null,
    stale_jobs_recovered: null,
    sources: [],
    processing: null,
    stale_articles_recovered: null,
    retries: null,
    briefs: null,
  };
  const pipelineJob = await db.createPipelineJob({
    job_type: 'pipeline-run',
    status: 'running',
    payload: null,
    result: null,
    error_message: null
  });

  let error: Error | undefined;
  let stage: NonNullable<PipelineRunSummary['failed_stage']> = 'recovery';

  try {
    // 0. Close out earlier runs that were cut off (this run's job is fresh).
    summary.stale_jobs_recovered = await db.recoverStalePipelineJobs(STALE_PIPELINE_JOB_SECONDS);

    // 1. Ingestion
    stage = 'ingestion';
    const sources = await db.listSources();
    for (const source of sources.slice(0, MAX_SOURCES)) {
      const now = Math.floor(Date.now() / 1000);
      const health = await db.getSourceHealth(source.id);
      const entry: SourceRunSummary = {
        id: source.id,
        name: source.name,
        outcome: 'unconfigured',
        parsed: null,
        inserted: null,
        newest_published_at: null,
        error: null,
      };
      summary.sources.push(entry);
      if (!hasFeedUrl(source)) {
        // Nothing is fetched, so this is neither a success nor a failure:
        // keep the previous timestamps and failure count.
        await db.updateSourceHealth(source.id, {
          status: 'unconfigured',
          last_success_at: health?.last_success_at ?? null,
          last_failure_at: health?.last_failure_at ?? null,
          consecutive_failures: health?.consecutive_failures ?? 0,
          error_message: 'No feed URL configured'
        });
        continue;
      }
      try {
        const ingest = await fetchAndIngest(env, source);
        entry.parsed = ingest.parsed;
        entry.inserted = ingest.inserted;
        entry.newest_published_at = ingest.newest_published_at;
        entry.outcome = 'healthy';
        await db.updateSourceHealth(source.id, {
          status: 'healthy',
          last_success_at: now,
          last_failure_at: health?.last_failure_at ?? null,
          consecutive_failures: 0,
          error_message: null
        });
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : 'Unknown error';
        // A fetch that fails partway may have stored some items: the counts are unknown.
        Object.assign(entry, { outcome: 'down', parsed: null, inserted: null, newest_published_at: null, error: errorText(e) });
        await db.updateSourceHealth(source.id, {
          status: 'down',
          last_success_at: health?.last_success_at ?? null,
          last_failure_at: now,
          consecutive_failures: (health?.consecutive_failures ?? 0) + 1,
          error_message: errorMsg
        });
      }
    }

    // 2. Processing (Pending)
    stage = 'processing';
    const { articles } = await db.listArticles({ status: 'pending', limit: 100 });
    const processing = (summary.processing = emptyCounts());
    let totalAttempts = 0;
    // An article gets at most one processing attempt per run, and a deferral
    // (no Gemini model currently available) ends article processing for the run.
    const attemptedThisRun = new Set<number>();
    let deferred = false;

    for (const article of articles) {
      if (totalAttempts >= MAX_ARTICLES || deferred) break;
      const claimed = await db.claimArticle(article.id);
      if (!claimed) continue;

      totalAttempts++;
      attemptedThisRun.add(article.id);
      processing.attempted++;
      try {
        await processArticle(env, article);
        processing.succeeded++;
      } catch (e) {
        // processor handles ai_job status and logs
        deferred = e instanceof GeminiDeferredError;
        processing[deferred ? 'deferred' : 'failed']++;
        await db.updateArticleStatus(article.id, deferred ? 'pending' : 'failed');
      }
    }

    // 3. Retry Processing (Failed)
    stage = 'retries';
    const retries = (summary.retries = emptyCounts());
    summary.stale_articles_recovered = await db.recoverStaleProcessingArticles(900); // 15 minutes

    const remainingSlots = MAX_ARTICLES - totalAttempts;
    if (remainingSlots > 0 && !deferred) {
      const retryCandidates = await db.listRetryableFailedArticles(remainingSlots);
      for (const article of retryCandidates) {
        if (totalAttempts >= MAX_ARTICLES || deferred) break;
        if (attemptedThisRun.has(article.id)) continue;
        const claimed = await db.claimFailedArticle(article.id);
        if (!claimed) continue;

        totalAttempts++;
        attemptedThisRun.add(article.id);
        retries.attempted++;
        try {
          await processArticle(env, article);
          retries.succeeded++;
        } catch (e) {
          // A deferred retry returns to 'failed' with its retry budget untouched.
          deferred = e instanceof GeminiDeferredError;
          retries[deferred ? 'deferred' : 'failed']++;
          await db.updateArticleStatus(article.id, 'failed');
        }
      }
    }

    // 4. Grounded AI Event Brief Generation (its errors never fail the run)
    const briefs: NonNullable<PipelineRunSummary['briefs']> = { state: 'skipped', events: 0, generated: 0, failed: 0, deferred: 0, in_progress: 0 };
    summary.briefs = briefs;
    try {
      const tableReady = typeof db.hasEventBriefsTable === 'function' ? await db.hasEventBriefsTable() : true;
      if (tableReady && typeof db.getRecentActiveEvents === 'function') {
        const activeEvents = await db.getRecentActiveEvents(5);
        briefs.state = 'ran';
        if (Array.isArray(activeEvents)) {
          briefs.events = activeEvents.length;
          const now = Math.floor(Date.now() / 1000);
          for (const event of activeEvents) {
            if (!event.id || !event.event_hash) continue;

            // Phase 14: Bounded Scheduled Community Signal Generation
            try {
              await generateCommunitySignalsForEvent(env, event.id);
            } catch (_signalErr) {
              // Failure isolates to this event's community signals
            }

            try {
              const detail = await db.getEventDetailByHash(event.event_hash);
              if (!detail || !detail.articles || detail.articles.length === 0) continue;

              const currentFingerprint = await computeArticleFingerprint(event.id, detail.articles);
              const latestBrief = await db.getLatestEventBrief(event.id);

              const isMatch = latestBrief && latestBrief.article_fingerprint === currentFingerprint;
              // Skip if already completed for this exact event state
              if (isMatch && latestBrief.status === 'completed') {
                continue;
              }

              // Skip if another worker is actively generating for this exact state within lease timeout
              if (isMatch && latestBrief.status === 'generating' && (now - latestBrief.updated_at) < 300) {
                briefs.in_progress++;
                continue;
              }

              // Cooldown: if previous generation for this exact state failed within the last hour, do not retry storm
              if (isMatch && latestBrief.status === 'failed' && (now - latestBrief.updated_at) < 3600) {
                continue;
              }

              const newBrief = await generateAndSaveEventBrief(
                env,
                {
                  id: event.id,
                  hash: event.event_hash,
                  title: event.title,
                  description: event.description,
                  severity: event.severity,
                },
                detail.articles
              );
              briefs.generated++;

              // Phase 10: Narrative Delta (if Version >= 2 and previous brief exists)
              if (latestBrief && latestBrief.status === 'completed' && latestBrief.version < newBrief.version) {
                await generateAndSaveNarrativeDelta(
                  env,
                  {
                    id: event.id,
                    hash: event.event_hash,
                    title: event.title,
                    description: event.description,
                    severity: event.severity,
                  },
                  latestBrief,
                  newBrief,
                  detail.articles
                ).catch(() => null);
              }

              // Phase 10: Cross-Source Claim Comparisons
              await generateAndSaveClaimComparisons(
                env,
                {
                  id: event.id,
                  hash: event.event_hash,
                  title: event.title,
                  description: event.description,
                  severity: event.severity,
                },
                newBrief,
                detail.articles
              ).catch(() => null);
            } catch (briefErr) {
              // Failure on individual event brief does not block other events.
              // Later steps catch their own errors, so this is the brief itself.
              if (briefErr instanceof EventBriefLeaseHeldError) briefs.in_progress++;
              else briefs[briefErr instanceof GeminiDeferredError ? 'deferred' : 'failed']++;
            }
          }
        }
      }
    } catch (_e) {
      // Pipeline continues safely even if brief stage encounters unexpected schema state
      briefs.state = 'errored';
    }
  } catch (e) {
    error = e instanceof Error ? e : new Error(String(e));
    summary.failed_stage = stage;
  } finally {
    summary.completed_at = Math.floor(Date.now() / 1000);
    await db.updatePipelineJobStatus(
      pipelineJob.id,
      error ? 'failed' : 'completed',
      error?.message,
      JSON.stringify(summary)
    );
    if (error) throw error;
  }
}
