/**
 * AI Article Processor
 */

import type { Env, ArticleRaw } from '../types';
import { createDbClient } from '../db/client';
import { generateEnrichment, type GeminiResponse } from './gemini';

export async function processArticle(env: Env, article: ArticleRaw): Promise<void> {
  const db = createDbClient(env);
  const aiJob = await db.createAiJob({
    article_raw_id: article.id,
    job_type: 'enrichment',
    model: 'gemini-3.6-flash',
    status: 'running',
  });

  try {
    const prompt = `Analyze this article and return JSON with summary, topics (list of strings), and events (list with title, description, severity):
Title: ${article.title}
Summary: ${article.summary ?? 'N/A'}
Content: ${article.raw_content?.slice(0, 2000) ?? 'N/A'}`;

    const enrichment = await retryWithBackoff(() => generateEnrichment(env, prompt));
    validateEnrichment(enrichment);

    // Save content
    await db.createArticleContent({
      article_raw_id: article.id,
      cleaned_text: enrichment.summary,
      extracted_entities: JSON.stringify({ topics: enrichment.topics, events: enrichment.events }),
    });

    // Save topics
    for (const topicName of enrichment.topics) {
      const slug = topicName.toLowerCase().replace(/[^a-z0-9]/g, '-');
      let topic = await db.getTopicBySlug(slug);
      if (!topic) {
        const id = await db.createTopic(topicName, slug);
        topic = { id, name: topicName, slug, description: null, parent_id: null, active: 1, created_at: 0 };
      }
      await db.linkArticleTopic(article.id, topic.id, 1.0);
    }

    // Save events
    for (const eventData of enrichment.events) {
      const eventHash = await generateEventHash(eventData.title, eventData.description ?? '');
      let event = await db.getEventByHash(eventHash);
      if (!event) {
        const id = await db.createEvent({
          event_hash: eventHash,
          title: eventData.title,
          description: eventData.description,
          severity: eventData.severity,
          started_at: null,
          ended_at: null,
          status: 'active',
        });
        event = { id, event_hash: eventHash, ...eventData, started_at: null, ended_at: null, status: 'active', created_at: 0 };
      }
      await db.linkArticleEvent(article.id, event.id, 1.0);
    }

    await db.updateArticleStatus(article.id, 'processed');
    await db.updateAiJobStatus(aiJob.id, 'completed', JSON.stringify(enrichment));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    await db.createAiLog(aiJob.id, message, 'error');
    await db.updateAiJobStatus(aiJob.id, 'failed', undefined, message);
    throw error;
  }
}

function validateEnrichment(data: any): asserts data is GeminiResponse {
  if (typeof data.summary !== 'string') throw new Error('Invalid summary');
  if (!Array.isArray(data.topics) || !data.topics.every((t: any) => typeof t === 'string')) throw new Error('Invalid topics');
  if (!Array.isArray(data.events)) throw new Error('Invalid events');
  const severities = ['low', 'medium', 'high', 'critical'];
  for (const e of data.events) {
    if (typeof e.title !== 'string' || typeof e.description !== 'string' || !severities.includes(e.severity)) {
      throw new Error('Invalid event structure');
    }
  }
}

async function generateEventHash(title: string, description: string): Promise<string> {
  const input = `${title.toLowerCase().trim()}|${description.toLowerCase().trim()}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function retryWithBackoff<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === retries - 1) throw e;
      const message = (e as Error).message;
      const statusMatch = message.match(/(\d{3})/);
      if (statusMatch) {
        const status = parseInt(statusMatch[1], 10);
        if (status === 429 || (status >= 500 && status <= 599)) {
          await new Promise((resolve) => setTimeout(resolve, Math.pow(2, i) * 100)); // Using 100ms for testing performance
          continue;
        }
      }
      throw e;
    }
  }
  throw new Error('Retry failed');
}
