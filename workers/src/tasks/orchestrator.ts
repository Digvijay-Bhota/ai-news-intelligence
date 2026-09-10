/**
 * Pipeline Orchestrator
 */

import type { Env } from '../types';
import { createDbClient } from '../db/client';
import { fetchAndIngest } from './fetcher';
import { processArticle } from './processor';
import { computeArticleFingerprint, generateAndSaveEventBrief } from './brief-generator';
import { generateAndSaveNarrativeDelta } from './narrative-delta-generator';
import { generateAndSaveClaimComparisons } from './claim-comparison-generator';

const MAX_SOURCES = 10;
const MAX_ARTICLES = 20;

export async function runPipeline(env: Env): Promise<void> {
  const db = createDbClient(env);
  const pipelineJob = await db.createPipelineJob({
    job_type: 'pipeline-run',
    status: 'running',
    payload: null,
    result: null,
    error_message: null
  });

  let error: Error | undefined;

  try {
    // 1. Ingestion
    const sources = await db.listSources();
    for (const source of sources.slice(0, MAX_SOURCES)) {
      const now = Math.floor(Date.now() / 1000);
      const health = await db.getSourceHealth(source.id);
      try {
        await fetchAndIngest(env, source);
        await db.updateSourceHealth(source.id, {
          status: 'healthy',
          last_success_at: now,
          last_failure_at: health?.last_failure_at ?? null,
          consecutive_failures: 0,
          error_message: null
        });
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : 'Unknown error';
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
    const { articles } = await db.listArticles({ status: 'pending', limit: 100 });
    let totalAttempts = 0;

    for (const article of articles) {
      if (totalAttempts >= MAX_ARTICLES) break;
      const claimed = await db.claimArticle(article.id);
      if (!claimed) continue;

      totalAttempts++;
      try {
        await processArticle(env, article);
      } catch (e) {
        await db.updateArticleStatus(article.id, 'failed');
        // processor handles ai_job status and logs
      }
    }

    // 3. Retry Processing (Failed)
    await db.recoverStaleProcessingArticles(900); // 15 minutes

    const remainingSlots = MAX_ARTICLES - totalAttempts;
    if (remainingSlots > 0) {
      const retryCandidates = await db.listRetryableFailedArticles(remainingSlots);
      for (const article of retryCandidates) {
        if (totalAttempts >= MAX_ARTICLES) break;
        const claimed = await db.claimFailedArticle(article.id);
        if (!claimed) continue;

        totalAttempts++;
        try {
          await processArticle(env, article);
        } catch (e) {
          await db.updateArticleStatus(article.id, 'failed');
        }
      }
    }

    // 4. Grounded AI Event Brief Generation
    try {
      const tableReady = typeof db.hasEventBriefsTable === 'function' ? await db.hasEventBriefsTable() : true;
      if (tableReady && typeof db.getRecentActiveEvents === 'function') {
        const activeEvents = await db.getRecentActiveEvents(5);
        if (Array.isArray(activeEvents)) {
          const now = Math.floor(Date.now() / 1000);
          for (const event of activeEvents) {
            if (!event.id || !event.event_hash) continue;
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
            } catch (_briefErr) {
              // Failure on individual event brief does not block other events
            }
          }
        }
      }
    } catch (_e) {
      // Pipeline continues safely even if brief stage encounters unexpected schema state
    }
  } catch (e) {
    error = e instanceof Error ? e : new Error(String(e));
  } finally {
    await db.updatePipelineJobStatus(
      pipelineJob.id,
      error ? 'failed' : 'completed',
      error?.message
    );
    if (error) throw error;
  }
}
