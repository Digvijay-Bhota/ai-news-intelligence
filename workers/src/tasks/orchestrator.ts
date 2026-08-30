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

  try {
    // 1. Ingestion
    const sources = await db.listSources();
    for (const source of sources.slice(0, MAX_SOURCES)) {
      try {
        await fetchAndIngest(env, source);
        await db.updateSourceHealth(source.id, 'success');
      } catch (e) {
        await db.updateSourceHealth(source.id, 'failed', e instanceof Error ? e.message : 'Unknown error');
      }
    }

    // 2. Processing
    const { articles } = await db.listArticles({ status: 'pending', limit: 100 });
    for (const article of articles.slice(0, MAX_ARTICLES)) {
      const claimed = await db.claimArticle(article.id);
      if (!claimed) continue;
      
      try {
        await processArticle(env, article);
      } catch (e) {
        await db.updateArticleStatus(article.id, 'failed');
        // processor handles ai_job status and logs
      }
    }

    await db.updatePipelineJobStatus(pipelineJob.id, 'completed');
  } catch (e) {
    await db.updatePipelineJobStatus(pipelineJob.id, 'failed', e instanceof Error ? e.message : 'Unknown error');
    throw e;
  }
}
