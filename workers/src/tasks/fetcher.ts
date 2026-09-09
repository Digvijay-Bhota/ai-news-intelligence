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
export function parseRss(xml: string): IngestedArticle[] {
  const articles: IngestedArticle[] = [];
  const seenIds = new Set<string>();

  // Match both <item> (RSS) and <entry> (Atom)
  const itemMatches = xml.matchAll(/<(item|entry)[\s>]([\s\S]*?)<\/\1>/gi);

  for (const match of itemMatches) {
    const item = match[2];
    const title = extractTag(item, 'title');

    // Atom <link href="..."/> or RSS <link>...</link>
    let link = extractTag(item, 'link');
    if (!link) {
      const linkMatch = item.match(/<link[^>]*href=["']([^"']+)["'][^>]*>/i);
      if (linkMatch) link = linkMatch[1];
    }

    const summary = extractTag(item, 'description') || extractTag(item, 'summary') || extractTag(item, 'content');
    const pubDateStr = extractTag(item, 'pubDate') || extractTag(item, 'published') || extractTag(item, 'updated');
    const guid = extractTag(item, 'guid') || extractTag(item, 'id');

    if (link && title) {
      const external_id = (guid || link).trim();
      if (seenIds.has(external_id)) continue;
      seenIds.add(external_id);

      const parsedDate = pubDateStr ? new Date(pubDateStr).getTime() : NaN;

      articles.push({
        external_id,
        title: title.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim(),
        summary: summary ? summary.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim() : null,
        url: link.trim(),
        published_at: !isNaN(parsedDate) ? Math.floor(parsedDate / 1000) : null,
        raw_content: match[0],
      });
    }
  }
  return articles;
}

function extractTag(xml: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}(?:\\s[^>]*?)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}
