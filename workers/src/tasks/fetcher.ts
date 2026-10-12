/**
 * Ingestion Fetcher — RSS/API Support
 */

import type { Env, Source } from '../types';
import { createDbClient, type DbClient } from '../db/client';
import { generateArticleHash } from './normalization';
import { extractArticleImageFields } from '../utils/article-image';
import { CDATA_PATTERN, parseAttributes, xmlTextContent } from '../utils/image-extraction';

/** external_id and hash inputs exactly as the parser stored them before XML entity decoding. */
export interface LegacyArticleIdentity {
  external_id: string;
  title: string;
  url: string;
}

export interface IngestedArticle {
  external_id: string;
  title: string;
  summary: string | null;
  url: string;
  published_at: number | null;
  raw_content: string | null;
  /**
   * Present only when the pre-decoding parser would have produced a different
   * external_id, title or URL; rows it stored are found through these values.
   */
  legacy?: LegacyArticleIdentity;
}

/** A NULL, empty or whitespace-only feed_url means the source has no feed to fetch. */
export function hasFeedUrl(source: Pick<Source, 'feed_url'>): source is Pick<Source, 'feed_url'> & { feed_url: string } {
  return typeof source.feed_url === 'string' && source.feed_url.trim() !== '';
}

export async function fetchAndIngest(env: Env, source: Source): Promise<number> {
  if (!hasFeedUrl(source)) return 0;

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

    // An edited title changes the hash but keeps the guid; external_id is unique.
    if (await db.getArticleByExternalId(article.external_id)) continue;

    if (article.legacy && await isLegacyDuplicate(db, article.legacy, article.external_id, hash)) continue;

    // Never throws: no eligible image (or any extraction error) means null fields.
    const image = extractArticleImageFields(article.raw_content, source.name);

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
      image_url: image.image_url,
      image_credit: image.image_credit,
    });

    await db.createDedupHash(hash, newArticle.id);
    ingested++;
  }

  return ingested;
}

/**
 * Rows stored before entity decoding keep their encoded external_id and a hash
 * of the encoded title/URL; neither is rewritten, so look both up as well.
 */
async function isLegacyDuplicate(
  db: DbClient,
  legacy: LegacyArticleIdentity,
  externalId: string,
  hash: string,
): Promise<boolean> {
  if (legacy.external_id !== externalId && await db.getArticleByExternalId(legacy.external_id)) return true;
  const legacyHash = await generateArticleHash(legacy.title, legacy.url);
  return legacyHash !== hash && !!(await db.getDedupHash(legacyHash));
}

/**
 * Minimal RSS/Atom parser without extra dependencies.
 * Extracts: title, link, description/summary, pubDate/published
 *
 * Text fields are XML text: CDATA is kept literally and other text is
 * entity-decoded exactly once (escaped HTML stays HTML for the next layer).
 */
export function parseRss(xml: string): IngestedArticle[] {
  const articles: IngestedArticle[] = [];
  const seenIds = new Set<string>();

  // Match both <item> (RSS) and <entry> (Atom)
  const itemMatches = xml.matchAll(/<(item|entry)[\s>]([\s\S]*?)<\/\1>/gi);

  for (const match of itemMatches) {
    const item = match[2];
    const title = elementText(item, 'title');
    const link = articleLink(item);
    const summary = elementText(item, 'description', 'summary', 'content');
    const pubDateStr = extractTag(item, 'pubDate') || extractTag(item, 'published') || extractTag(item, 'updated');
    const guid = elementText(item, 'guid', 'id');

    if (link && title) {
      const external_id = guid || link;
      if (seenIds.has(external_id)) continue;
      seenIds.add(external_id);

      const parsedDate = pubDateStr ? new Date(pubDateStr).getTime() : NaN;
      const legacy = legacyIdentity(item);

      articles.push({
        external_id,
        title,
        summary: summary || null,
        url: link,
        published_at: !isNaN(parsedDate) ? Math.floor(parsedDate / 1000) : null,
        raw_content: match[0],
        ...(legacy && (legacy.external_id !== external_id || legacy.title !== title || legacy.url !== link)
          ? { legacy }
          : {}),
      });
    }
  }
  return articles;
}

function matchElement(xml: string, tag: string): RegExpMatchArray | null {
  return xml.match(new RegExp(`<${tag}(\\s[^>]*?)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
}

function extractTag(xml: string, tag: string): string | null {
  const match = matchElement(xml, tag);
  return match ? match[2].trim() : null;
}

/**
 * Decoded, trimmed text of the first listed element with non-empty content,
 * or null. Atom type="xhtml" content is inline markup rather than escaped
 * text, so it is kept as-is and its entities are left for the HTML layer.
 */
function elementText(xml: string, ...tags: string[]): string | null {
  for (const tag of tags) {
    const match = matchElement(xml, tag);
    if (!match || !match[2].trim()) continue;
    const isXhtml = parseAttributes(match[1] ?? '').type?.trim().toLowerCase() === 'xhtml';
    return (isXhtml ? match[2] : xmlTextContent(match[2])).trim();
  }
  return null;
}

const ALTERNATE_RELS = new Set(['alternate', 'http://www.iana.org/assignments/relation/alternate']);

/** True for an absolute http(s) URL; the value itself is stored unnormalized. */
function isAbsoluteHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    return new URL(value).hostname !== '';
  } catch {
    return false;
  }
}

/**
 * The entry's article URL. An RSS <link> element's text or an Atom link with
 * rel="alternate" wins; an Atom link without rel (alternate by default) is the
 * fallback. Other rels (self, enclosure, related, ...) are never the article.
 * Ties go to document order; only absolute http(s) URLs qualify.
 */
function articleLink(item: string): string | null {
  // Same-length masking: <link> tags inside CDATA HTML are not entry links.
  const masked = item.replace(CDATA_PATTERN, m => ' '.repeat(m.length));
  const closePattern = /<\/link\s*>/gi;
  let fallback: string | null = null;
  // Once no </link> follows, none follows later tags either: never rescan.
  let unclosed = false;

  for (const tag of masked.matchAll(/<link(?=[\s/>])((?:"[^"]*"|'[^']*'|[^'">])*)>/gi)) {
    const attrs = parseAttributes(tag[1]);
    let url: string;
    let preferred: boolean;
    if (attrs.href === undefined) {
      if (unclosed || /\/\s*$/.test(tag[1])) continue;
      const start = tag.index! + tag[0].length;
      closePattern.lastIndex = start;
      const close = closePattern.exec(masked);
      if (!close) {
        unclosed = true;
        continue;
      }
      url = xmlTextContent(item.slice(start, close.index)).trim();
      preferred = true;
    } else {
      const rels = (attrs.rel ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (rels.some(rel => !ALTERNATE_RELS.has(rel))) continue;
      url = attrs.href.trim();
      preferred = rels.length > 0;
    }
    if (!isAbsoluteHttpUrl(url)) continue;
    if (preferred) return url;
    fallback ??= url;
  }
  return fallback;
}

/**
 * The identity the parser computed before entity decoding, Atom rel filtering
 * and URL validation: raw element text, CDATA stripped (single-line only) from
 * the title, and the first <link href> of any rel. Do not change: it must keep
 * matching rows that parser stored.
 */
function legacyIdentity(item: string): LegacyArticleIdentity | null {
  const title = extractTag(item, 'title');
  let link = extractTag(item, 'link');
  if (!link) {
    const linkMatch = item.match(/<link[^>]*href=["']([^"']+)["'][^>]*>/i);
    if (linkMatch) link = linkMatch[1];
  }
  if (!link || !title) return null;
  const guid = extractTag(item, 'guid') || extractTag(item, 'id');
  return {
    external_id: (guid || link).trim(),
    title: title.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim(),
    url: link.trim(),
  };
}
