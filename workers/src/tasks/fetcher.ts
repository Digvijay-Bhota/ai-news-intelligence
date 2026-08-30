/**
 * Ingestion Fetcher — RSS/API Support
 */

import type { Env, Source } from '../types';
import { createDbClient } from '../db/client';
import { generateArticleHash } from './normalization';

export interface IngestedArticle {
  external_id: string;
  title: string;
  summary: string | null;
  url: string;
  published_at: number | null;
  raw_content: string | null;
}

export async function fetchAndIngest(env: Env, source: Source): Promise<number> {
  if (!source.feed_url) return 0;

  const response = await fetch(source.feed_url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${source.feed_url}: ${response.statusText}`);
  }

  const text = await response.text();
  const articles = parseRss(text);
  const db = createDbClient(env);
  let ingested = 0;

  for (const article of articles) {
    const hash = await generateArticleHash(article.title, article.url);
    const existingHash = await db.getDedupHash(hash);
    if (existingHash) continue;

    const newArticle = await db.createArticle({
      external_id: article.external_id,
      source_id: source.id,
      title: article.title,
      summary: article.summary,
      url: article.url,
      raw_content: article.raw_content,
      published_at: article.published_at,
      language: 'en',
      status: 'pending',
    });

    await db.createDedupHash(hash, newArticle.id);
    ingested++;
  }

  return ingested;
}

/**
 * Minimal RSS/Atom parser without extra dependencies.
 * Extracts: title, link, description/summary, pubDate/published
 */
function parseRss(xml: string): IngestedArticle[] {
  const articles: IngestedArticle[] = [];
  // Very simplistic regex-based item extraction
  const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/gi);
  for (const match of itemMatches) {
    const item = match[1];
    const title = extractTag(item, 'title');
    const link = extractTag(item, 'link');
    const summary = extractTag(item, 'description') || extractTag(item, 'summary');
    const pubDate = extractTag(item, 'pubDate') || extractTag(item, 'published') || extractTag(item, 'updated');

    if (link && title) {
      articles.push({
        external_id: link, // Use URL as unique ID
        title: title.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1'),
        summary: summary ? summary.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1') : null,
        url: link,
        published_at: pubDate ? Math.floor(new Date(pubDate).getTime() / 1000) : null,
        raw_content: item, // Store full XML item for potential future enrichment
      });
    }
  }
  return articles;
}

function extractTag(xml: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}
