/**
 * Pipeline Orchestrator
 */

import type { Env } from '../types';
import { createDbClient } from '../db/client';
import { fetchAndIngest } from './fetcher';
import { processArticle } from './processor';

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
