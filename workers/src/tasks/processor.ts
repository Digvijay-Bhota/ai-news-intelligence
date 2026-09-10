/**
 * AI Article Processor
 */

import type { Env, ArticleRaw } from '../types';
import { createDbClient } from '../db/client';
import { generateEnrichment, matchEventToCluster, type GeminiResponse } from './gemini';
import { ApiError } from '../utils/errors';
import { formatSandboxedArticleForEnrichment, PROMPT_SANDBOX_SECURITY_RULES } from './prompt-sandbox';

export async function processArticle(env: Env, article: ArticleRaw): Promise<void> {
  const db = createDbClient(env);
  const aiJob = await db.createAiJob({
    article_raw_id: article.id,
    job_type: 'enrichment',
    model: 'gemini-3.6-flash',
    status: 'running',
  });

  try {
    const sandboxedArticle = formatSandboxedArticleForEnrichment({
      id: article.id,
      source: `Source #${article.source_id}`,
      published_at: article.published_at,
      title: article.title,
      summary: article.summary,
      raw_content: article.raw_content,
    });

    const prompt = `Analyze this article and return ONLY a JSON object with exactly the following structure:
{
  "summary": "string",
  "topics": ["string"],
  "events": [
    {
      "title": "string",
      "description": "string",
      "severity": "low|medium|high|critical"
    }
  ]
}

${PROMPT_SANDBOX_SECURITY_RULES}

CRITICAL INSTRUCTIONS:
- Output JSON ONLY. No markdown formatting, no code fences (\`\`\`json).
- If there are no meaningful events, return an empty array for events: []
- title must be a non-empty string.
- description must be a non-empty string.
- severity must be exactly one of: low, medium, high, critical.
- Do NOT use null for any event fields.

UNTRUSTED ARTICLE EVIDENCE:
<grounded_evidence>
${sandboxedArticle}
</grounded_evidence>`;

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

    // Pre-fetch candidate events for semantic matching (bounded to 30)
    let candidateEvents: { id: number; event_hash: string; title: string; description: string | null; severity: string }[] = [];
    if (enrichment.events.length > 0) {
      candidateEvents = await db.getRecentActiveEvents(30);
    }

    // Save events
    for (const eventData of enrichment.events) {
      let matchedEventId: number | null = null;
      let eventHash = '';

      if (candidateEvents.length > 0) {
        try {
          const matchResult = await retryWithBackoff(() =>
            matchEventToCluster(env, { title: eventData.title, description: eventData.description }, candidateEvents)
          );

          if (matchResult.match && matchResult.event_id) {
            // Verify event_id is actually in candidates
            if (candidateEvents.some(c => c.id === matchResult.event_id)) {
              matchedEventId = matchResult.event_id;
            }
          }
        } catch (error) {
          // Failure in matching should gracefully fallback to new event creation
          console.warn('Semantic matching failed, falling back to new event creation', error);
        }
      }

      if (matchedEventId !== null) {
        await db.linkArticleEvent(article.id, matchedEventId, 1.0);
      } else {
        eventHash = await generateEventHash(eventData.title, eventData.description ?? '');
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
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid structure: expected a JSON object');
  }
  if (typeof data.summary !== 'string') {
    throw new Error('Invalid structure: summary must be a string');
  }
  if (!Array.isArray(data.topics) || !data.topics.every((t: any) => typeof t === 'string')) {
    throw new Error('Invalid structure: topics must be an array of strings');
  }
  if (!Array.isArray(data.events)) {
    throw new Error('Invalid structure: events must be an array');
  }

  const severities = ['low', 'medium', 'high', 'critical'];
  for (const e of data.events) {
    if (!e || typeof e !== 'object') {
      throw new Error('Invalid event structure: event must be an object');
    }
    if (typeof e.title !== 'string' || e.title.trim() === '') {
      throw new Error('Invalid event structure: title must be a non-empty string');
    }
    if (typeof e.description !== 'string' || e.description.trim() === '') {
      throw new Error('Invalid event structure: description must be a non-empty string');
    }
    if (!severities.includes(e.severity)) {
      throw new Error('Invalid event structure: severity must be one of low, medium, high, critical');
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

export async function retryWithBackoff<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === retries - 1) throw e;
      if (e instanceof ApiError) {
        if (e.status === 429 || (e.status >= 500 && e.status <= 599)) {
          await new Promise((resolve) => setTimeout(resolve, Math.pow(2, i) * 100)); // Using 100ms for testing performance
          continue;
        }
      }
      throw e;
    }
  }
  throw new Error('Retry failed');
}
