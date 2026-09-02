import React from 'react';
import Link from 'next/link';
import { env } from 'cloudflare:workers';
import { generateHmac } from '../../../utils/hmac';
import { EventDetailResponse } from '../../../types';
import { ArticleCard } from '../../../components/ArticleCard';
import { ErrorState } from '../../../components/ErrorState';
import { EmptyState } from '../../../components/EmptyState';
import { ChevronLeftIcon } from '../../../components/icons';

export const runtime = 'edge';

async function getEvent(hash: string): Promise<EventDetailResponse> {
  const secret = env.HMAC_SECRET;
  if (!secret) throw new Error('Missing HMAC_SECRET');

  const backend = env.BACKEND_API;
  if (!backend || typeof backend.fetch !== 'function') throw new Error('Missing BACKEND_API binding');

  const ts = Math.floor(Date.now() / 1000);
  const nonce = `nonce-${ts}-${Math.random().toString(36).substring(2, 9)}`;
  const fullPath = `/api/v1/events/${hash}`;

  const hmacPayload = {
    method: 'GET',
    path: fullPath,
    timestamp: ts,
    nonce,
    body: '',
  };

  const signature = await generateHmac(hmacPayload, secret);

  const backendReq = new Request(`http://backend${fullPath}`, {
    method: 'GET',
    headers: {
      'X-HMAC-Signature': signature,
      'X-Nonce': nonce,
      'X-Timestamp': String(ts),
    },
  });

  const res = await backend.fetch(backendReq);

  if (!res.ok) {
    throw new Error(`Backend error: ${res.status}`);
  }

  return res.json();
}

function freshnessLabel(freshness: 'developing' | 'active' | 'stale'): string {
  if (freshness === 'developing') return 'New coverage arriving in the last 24 hours.';
  if (freshness === 'stale') return 'No new coverage in over 48 hours. This story may have concluded.';
  return 'Coverage is ongoing.';
}

function freshnessClasses(freshness: 'developing' | 'active' | 'stale'): string {
  if (freshness === 'developing') {
    return 'bg-emerald-50 border-emerald-200 text-emerald-800 dark:bg-emerald-500/10 dark:border-emerald-500/20 dark:text-emerald-300';
  }
  if (freshness === 'stale') {
    return 'bg-gray-50 border-gray-200 text-gray-600 dark:bg-gray-800/50 dark:border-gray-700 dark:text-gray-400';
  }
  return 'bg-blue-50 border-blue-200 text-blue-800 dark:bg-blue-500/10 dark:border-blue-500/20 dark:text-blue-300';
}

function freshnessBadgeClasses(freshness: 'developing' | 'active' | 'stale'): string {
  if (freshness === 'developing') {
    return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-400';
  }
  if (freshness === 'stale') {
    return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400';
  }
  return 'bg-blue-100 text-blue-800 dark:bg-blue-500/10 dark:text-blue-400';
}

function severityBadgeClasses(severity: string): string {
  if (severity === 'critical') return 'bg-red-100 text-red-800 dark:bg-red-500/10 dark:text-red-400';
  if (severity === 'warning') return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-500/10 dark:text-yellow-400';
  return 'bg-blue-100 text-blue-800 dark:bg-blue-500/10 dark:text-blue-400';
}

export default async function EventPage({ params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  let eventDetail: EventDetailResponse | undefined;

  try {
    eventDetail = await getEvent(hash);
  } catch (_error) {
    return (
      <div className="max-w-4xl mx-auto py-8">
        <ErrorState message="Failed to load the event timeline." />
      </div>
    );
  }

  if (!eventDetail.success || !eventDetail.data) {
    return (
      <div className="max-w-4xl mx-auto py-8 text-center">
        <EmptyState title="Event Not Found" message="This event does not exist or has been removed." />
        <Link href="/" className="mt-4 inline-block text-indigo-600 hover:text-indigo-800">
          Return to Feed
        </Link>
      </div>
    );
  }

  const { event, coverage, intelligence, articles } = eventDetail.data;
  const nowSeconds = Math.floor(Date.now() / 1000);

  // Human-readable last coverage elapsed time
  const lastCoverageDisplay: string | null = event.last_published_at
    ? (() => {
        const elapsed = nowSeconds - event.last_published_at!;
        if (elapsed < 3600) return 'Less than 1 hour ago';
        if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h ago`;
        const days = Math.floor(elapsed / 86400);
        return `${days} day${days !== 1 ? 's' : ''} ago`;
      })()
    : null;

  // Cap topic display at 12, track overflow count
  const TOPIC_DISPLAY_LIMIT = 12;
  const displayedTopics = intelligence?.unique_topics?.slice(0, TOPIC_DISPLAY_LIMIT) ?? [];
  const hiddenTopicCount = Math.max(0, (intelligence?.unique_topics?.length ?? 0) - TOPIC_DISPLAY_LIMIT);

  return (
    <div className="max-w-4xl mx-auto">

      {/* Back + events navigation */}
      <nav className="flex items-center gap-3 mb-6" aria-label="Breadcrumb">
        <Link
          href="/"
          className="inline-flex items-center text-sm font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded"
        >
          <ChevronLeftIcon className="w-4 h-4 mr-1" />
          Back to Feed
        </Link>
        <span className="text-gray-300 dark:text-gray-700" aria-hidden="true">·</span>
        <Link
          href="/events"
          className="text-sm font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded"
        >
          All Events
        </Link>
      </nav>

      {/* ── 1. Event Overview ────────────────────────────────────── */}
      <header className="mb-8 pb-6 border-b border-gray-200 dark:border-gray-800">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wide ${severityBadgeClasses(event.severity)}`}>
            {event.severity}
          </span>
          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${freshnessBadgeClasses(event.freshness)}`}>
            {event.freshness}
          </span>
        </div>

        <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-3 tracking-tight">
          {event.title}
        </h1>

        {event.description && (
          <p className="text-lg text-gray-600 dark:text-gray-300 leading-relaxed max-w-3xl mb-4">
            {event.description}
          </p>
        )}

        <p className="text-sm text-gray-500 dark:text-gray-400">
          {lastCoverageDisplay ? (
            <>Last coverage: <time dateTime={new Date(event.last_published_at! * 1000).toISOString()}>{lastCoverageDisplay}</time></>
          ) : (
            'Last coverage time unavailable'
          )}
        </p>
      </header>

      {/* ── 2. Freshness / Lifecycle Explanation ─────────────────── */}
      <section
        aria-label="Story freshness status"
        className={`mb-8 px-5 py-4 rounded-lg border text-sm leading-relaxed ${freshnessClasses(event.freshness)}`}
      >
        <span className="font-semibold capitalize">{event.freshness}:</span>{' '}
        {freshnessLabel(event.freshness)}
      </section>

      {/* ── 3. Story Intelligence ─────────────────────────────────── */}
      {intelligence && (
        <section
          aria-label="Story intelligence summary"
          className="mb-10 p-6 bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-sm"
        >
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4 flex items-center gap-2">
            <svg className="w-5 h-5 text-indigo-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            Story Intelligence
          </h2>

          {/* Metrics grid */}
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
            <div>
              <dt className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Topics Tracked</dt>
              <dd className="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-1">{intelligence.topic_count}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Days Active</dt>
              <dd className="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-1">
                {intelligence.days_active !== null ? intelligence.days_active : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Articles / Day</dt>
              <dd className="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-1">
                {intelligence.coverage_density !== null ? intelligence.coverage_density : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Top Source</dt>
              <dd className="text-sm font-semibold text-gray-900 dark:text-gray-100 mt-1 truncate" title={intelligence.top_source ?? undefined}>
                {intelligence.top_source ?? '—'}
              </dd>
            </div>
          </dl>

          {/* Topic badges */}
          {displayedTopics.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
                Topics in This Story
              </h3>
              <div className="flex flex-wrap gap-2">
                {displayedTopics.map((topic) => (
                  <span
                    key={topic}
                    className="inline-flex items-center px-2.5 py-1 rounded-md text-sm bg-indigo-50 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-500/20"
                  >
                    {topic}
                  </span>
                ))}
                {hiddenTopicCount > 0 && (
                  <span className="inline-flex items-center px-2.5 py-1 rounded-md text-sm bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700">
                    +{hiddenTopicCount} more
                  </span>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      {/* ── 4. Source Coverage ───────────────────────────────────── */}
      {coverage && (
        <section
          aria-label="Source coverage summary"
          className="mb-10 p-6 bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-sm"
        >
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4 flex items-center gap-2">
            <svg className="w-5 h-5 text-indigo-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9.5a2.5 2.5 0 00-2.5-2.5H15" />
            </svg>
            Coverage Summary
          </h2>

          <dl className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
            <div>
              <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Total Sources</dt>
              <dd className="text-2xl font-bold text-gray-900 dark:text-gray-100">{coverage.total_sources}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Total Articles</dt>
              <dd className="text-2xl font-bold text-gray-900 dark:text-gray-100">{coverage.total_articles}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">First Report</dt>
              <dd className="text-lg font-medium text-gray-900 dark:text-gray-100">
                {coverage.first_published_at
                  ? new Date(coverage.first_published_at * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
                  : 'Unknown'}
              </dd>
            </div>
          </dl>

          <div>
            <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-3">Sources Covering This Event</h3>
            <div className="flex flex-wrap gap-2">
              {coverage.sources.map((src) => (
                <span
                  key={src.name}
                  className="inline-flex items-center px-2.5 py-1 rounded-md text-sm bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-700"
                >
                  {src.name}
                  <span className="ml-1.5 px-1.5 py-0.5 rounded text-xs bg-gray-200 dark:bg-gray-700 font-medium">
                    {src.article_count}
                  </span>
                </span>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ── 5. Story Evolution Timeline ──────────────────────────── */}
      {articles.length === 0 ? (
        <EmptyState title="No articles found" message="There are no articles associated with this event timeline." />
      ) : (
        <div className="relative">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-6 flex items-center gap-2">
            <svg className="w-5 h-5 text-indigo-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Story Evolution
          </h2>

          {/* Vertical timeline line */}
          <div className="hidden md:block absolute left-8 top-14 bottom-0 w-px bg-gray-200 dark:bg-gray-800" aria-hidden="true" />

          <div className="space-y-12">
            {Object.entries(
              articles.reduce((acc, article, index) => {
                const isBreaking = index === 0;

                if (!acc.seenSources) acc.seenSources = new Set();
                const isFirstForSource = !acc.seenSources.has(article.source);
                if (isFirstForSource) acc.seenSources.add(article.source);

                // What Changed? — new topics introduced by this article
                if (!acc.seenTopics) acc.seenTopics = new Set();
                const newTopics: string[] = [];
                if (article.extracted_entities?.topics) {
                  for (const topic of article.extracted_entities.topics) {
                    if (!acc.seenTopics.has(topic.toLowerCase())) {
                      newTopics.push(topic);
                      acc.seenTopics.add(topic.toLowerCase());
                    }
                  }
                }

                const dateStr = article.published_at
                  ? new Date(article.published_at * 1000).toLocaleDateString(undefined, {
                      weekday: 'long',
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                    })
                  : 'Unknown Date';

                if (!acc.groups) acc.groups = {};
                if (!acc.groups[dateStr]) acc.groups[dateStr] = [];
                acc.groups[dateStr].push({ ...article, isBreaking, isFirstForSource, newTopics });
                return acc;
              }, { seenSources: new Set<string>(), seenTopics: new Set<string>(), groups: {} as Record<string, any[]> }).groups
            ).map(([dateStr, dayArticles]) => (
              <div key={dateStr} className="relative">
                {/* Date heading */}
                <div className="sticky top-4 z-10 mb-8 md:pl-20 flex items-center">
                  <div className="hidden md:flex absolute left-8 -translate-x-1/2 w-6 h-6 rounded-full bg-white dark:bg-gray-900 border-4 border-gray-200 dark:border-gray-800 items-center justify-center z-10" aria-hidden="true" />
                  <h3 className="inline-flex items-center px-4 py-1.5 rounded-full text-sm font-bold bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-gray-700 shadow-sm">
                    {dateStr}
                  </h3>
                </div>

                <div className="space-y-8">
                  {dayArticles.map((article) => (
                    <div key={article.id} className="relative md:pl-20">
                      {/* Timeline dot */}
                      <div className="hidden md:flex absolute left-8 -translate-x-1/2 top-6 w-4 h-4 rounded-full bg-indigo-100 dark:bg-indigo-900/50 border-2 border-indigo-500 items-center justify-center" aria-hidden="true">
                        <div className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
                      </div>

                      {/* What Changed? badges */}
                      {(article.isBreaking || article.isFirstForSource || article.newTopics.length > 0) && (
                        <div className="flex flex-wrap gap-2 mb-3">
                          {article.isBreaking && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800 dark:bg-red-500/10 dark:text-red-400 border border-red-200 dark:border-red-500/20">
                              🔥 Breaking Report
                            </span>
                          )}
                          {!article.isBreaking && article.isFirstForSource && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-500/10 dark:text-blue-400 border border-blue-200 dark:border-blue-500/20">
                              📰 First report by {article.source}
                            </span>
                          )}
                          {article.newTopics.length > 0 && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/20">
                              🏷️ New Topics: {article.newTopics.join(', ')}
                            </span>
                          )}
                        </div>
                      )}

                      <ArticleCard article={article} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Truncation notice */}
          {coverage && articles.length < coverage.total_articles && (
            <div className="mt-8 md:pl-20">
              <div className="p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg text-center border border-gray-200 dark:border-gray-800">
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Showing the first {articles.length} of {coverage.total_articles} total articles.
                  Topics, source markers, and &ldquo;What Changed?&rdquo; badges reflect only the visible window.
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
