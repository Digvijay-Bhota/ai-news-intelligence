/**
 * Daily AI Briefing — story selection and loading.
 *
 * Reads only existing, stored data: one priority-ordered event list request and
 * at most MAX_DETAIL_REQUESTS event detail requests. Never triggers brief
 * generation or any model call; stories without a completed brief are skipped.
 */

import { fetchActiveEvents, fetchEvent } from './api';
import type { EventDetailResponse, EventSummary } from '../types';

export const MAX_STORIES = 5;
export const MIN_FULL_BRIEFING = 3;
export const MAX_DETAIL_REQUESTS = 8;
/** Matches the backend "stale" freshness threshold (48 hours). */
export const STALE_AFTER_SECONDS = 172800;
/** Shared articles required before article overlap can mark two events as duplicates. */
export const MIN_SHARED_ARTICLES = 2;

export type EventDetail = EventDetailResponse['data'];

export interface BriefingStory {
  hash: string;
  title: string;
  summary: string;
  whyItMatters: string | null;
  change: { label: 'What changed' | 'Key development'; text: string } | null;
  uncertainty: string | null;
  entities: { name: string; type: string }[];
  topics: string[];
  lastActivityAt: number | null;
  isDeveloping: boolean;
  isCritical: boolean;
  sourceCount: number;
  articleCount: number;
  citationCount: number;
  briefOutdated: boolean;
}

export interface DailyBriefingResult {
  stories: BriefingStory[];
  /** Detail requests that failed and were skipped. */
  failedDetails: number;
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'over', 'after', 'amid', 'its',
  'new', 'says', 'said', 'will', 'are', 'has', 'have', 'that', 'this', 'about',
]);

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2 && !STOPWORDS.has(t)),
  );
}

/** True when two headlines describe the same development (near-identical wording). */
export function titlesOverlap(a: string, b: string): boolean {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size === 0 || tb.size === 0) return a.trim().toLowerCase() === b.trim().toLowerCase();
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const smaller = Math.min(ta.size, tb.size);
  return smaller >= 3 && shared / smaller >= 0.8;
}

/**
 * True when one event's coverage is largely contained in the other's.
 * Containment (not Jaccard) is intended, so a small fragment of a large
 * cluster still counts as a duplicate. Articles can belong to several events
 * (e.g. a roundup), so one shared article alone is not evidence.
 */
export function articlesOverlap(a: EventDetail, b: EventDetail): boolean {
  const keys = (d: EventDetail) => new Set((d.articles ?? []).map(art => art.url || `id:${art.id}`));
  const ka = keys(a);
  const kb = keys(b);
  const smaller = Math.min(ka.size, kb.size);
  if (smaller === 0) return false;
  let shared = 0;
  for (const k of ka) if (kb.has(k)) shared++;
  return shared >= MIN_SHARED_ARTICLES && shared / smaller >= 0.5;
}

export function isRecentlyActive(event: EventSummary, nowSeconds: number): boolean {
  if (event.freshness === 'stale') return false;
  if (event.last_published_at === null || event.last_published_at === undefined) return false;
  return nowSeconds - event.last_published_at < STALE_AFTER_SECONDS;
}

/**
 * Picks which events are worth a detail request: recently active, in priority
 * order, without near-duplicate headlines, capped at MAX_DETAIL_REQUESTS.
 */
export function preselectCandidates(items: EventSummary[], nowSeconds: number): EventSummary[] {
  const picked: EventSummary[] = [];
  for (const item of items) {
    if (picked.length >= MAX_DETAIL_REQUESTS) break;
    if (!item?.hash || !isRecentlyActive(item, nowSeconds)) continue;
    if (picked.some(p => p.hash === item.hash || titlesOverlap(p.title, item.title))) continue;
    picked.push(item);
  }
  return picked;
}

export function hasCompletedBrief(detail: EventDetail): boolean {
  return (
    detail.brief_metadata?.status === 'completed' &&
    !!detail.brief &&
    text(detail.brief.summary) !== null
  );
}

/** Keeps completed-brief, non-duplicate details in priority order, up to MAX_STORIES. */
export function selectStories(details: EventDetail[], nowSeconds: number): EventDetail[] {
  const selected: EventDetail[] = [];
  for (const detail of details) {
    if (selected.length >= MAX_STORIES) break;
    if (!detail?.event || !hasCompletedBrief(detail)) continue;
    const lastActivity = detail.event.last_published_at;
    if (detail.event.freshness === 'stale' || lastActivity === null || nowSeconds - lastActivity >= STALE_AFTER_SECONDS) continue;
    const duplicate = selected.some(s =>
      s.event.hash === detail.event.hash ||
      titlesOverlap(s.event.title, detail.event.title) ||
      articlesOverlap(s, detail),
    );
    if (!duplicate) selected.push(detail);
  }
  return selected;
}

/** Maps stored event data to the briefing view model. Absent or empty fields become null/[]. */
export function toBriefingStory(detail: EventDetail): BriefingStory {
  const { event, coverage, brief, brief_metadata, narrative_delta, intelligence, articles } = detail;
  const deltaSummary = text(narrative_delta?.summary);
  const keyDevelopment = (brief?.key_developments ?? []).map(text).find(Boolean) ?? null;
  const articleIds = new Set((articles ?? []).map(a => a.id));

  return {
    hash: event.hash,
    title: event.title,
    summary: text(brief?.summary) ?? '',
    whyItMatters: text(brief?.why_it_matters),
    change: deltaSummary
      ? { label: 'What changed', text: deltaSummary }
      : keyDevelopment
        ? { label: 'Key development', text: keyDevelopment }
        : null,
    uncertainty: (brief?.uncertainties ?? []).map(text).find(Boolean) ?? null,
    entities: (brief?.key_entities ?? [])
      .filter(e => text(e?.name))
      .slice(0, 4)
      .map(e => ({ name: e.name.trim(), type: text(e.type) ?? '' })),
    topics: (intelligence?.unique_topics ?? []).map(text).filter((t): t is string => !!t).slice(0, 2),
    lastActivityAt: event.last_published_at ?? null,
    isDeveloping: event.freshness === 'developing',
    isCritical: event.severity === 'critical',
    sourceCount: coverage?.total_sources ?? 0,
    articleCount: coverage?.total_articles ?? 0,
    citationCount: (brief?.source_references ?? []).filter(r => articleIds.has(r.article_id)).length,
    briefOutdated: brief_metadata?.is_stale === true,
  };
}

interface LoadOptions {
  signal?: AbortSignal;
  nowSeconds?: number;
  fetchList?: typeof fetchActiveEvents;
  fetchDetail?: typeof fetchEvent;
}

/**
 * Loads the briefing: one list request, then up to MAX_DETAIL_REQUESTS detail
 * requests in parallel. A failed detail request skips only that story.
 * Throws when the list fails, or when every detail request fails.
 */
export async function loadDailyBriefing(options: LoadOptions = {}): Promise<DailyBriefingResult> {
  const {
    signal,
    nowSeconds = Math.floor(Date.now() / 1000),
    fetchList = fetchActiveEvents,
    fetchDetail = fetchEvent,
  } = options;

  const list = await fetchList({ sort: 'priority' }, signal);
  if (!list?.success || !Array.isArray(list.data?.items)) {
    throw new Error('The events list returned an unexpected response.');
  }

  const candidates = preselectCandidates(list.data.items, nowSeconds);
  const settled = await Promise.allSettled(candidates.map(c => fetchDetail(c.hash, signal)));

  const details: EventDetail[] = [];
  let failedDetails = 0;
  for (const result of settled) {
    if (result.status === 'fulfilled' && result.value?.success && result.value.data) {
      details.push(result.value.data);
    } else {
      failedDetails++;
    }
  }

  if (candidates.length > 0 && failedDetails === candidates.length) {
    throw new Error('Story details could not be loaded.');
  }

  return { stories: selectStories(details, nowSeconds).map(toBriefingStory), failedDetails };
}
