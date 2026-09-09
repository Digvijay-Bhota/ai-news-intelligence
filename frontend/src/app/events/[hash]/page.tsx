import React from 'react';
import Link from 'next/link';
import { env } from 'cloudflare:workers';
import { generateHmac } from '../../../utils/hmac';
import { EventDetailResponse } from '../../../types';
import { ErrorState } from '../../../components/ErrorState';
import { EmptyState } from '../../../components/EmptyState';
import { ChevronLeftIcon, ClockIcon, RadarIcon, ActivityIcon, TrendingUpIcon } from '../../../components/icons';
import { EventTimeline } from '../../../components/EventTimeline';

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
  if (freshness === 'developing') return 'High-velocity active development. New articles and sources reported within the last 24 hours.';
  if (freshness === 'stale') return 'No new coverage reported in over 48 hours. This event cluster appears to have concluded or matured into follow-up stories.';
  return 'Ongoing story with continuous multi-source reporting across newsrooms.';
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
    return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/20';
  }
  if (freshness === 'stale') {
    return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400 border border-gray-200 dark:border-gray-600';
  }
  return 'bg-blue-100 text-blue-800 dark:bg-blue-500/10 dark:text-blue-400 border border-blue-200 dark:border-blue-500/20';
}

function severityBadgeClasses(severity: string): string {
  if (severity === 'critical') return 'bg-red-100 text-red-800 dark:bg-red-500/10 dark:text-red-400 border border-red-200 dark:border-red-500/20';
  if (severity === 'high' || severity === 'warning') return 'bg-amber-100 text-amber-800 dark:bg-amber-500/10 dark:text-amber-400 border border-amber-200 dark:border-amber-500/20';
  return 'bg-blue-100 text-blue-800 dark:bg-blue-500/10 dark:text-blue-400 border border-blue-200 dark:border-blue-500/20';
}

const SOURCE_COLORS = [
  'bg-indigo-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-rose-500',
  'bg-cyan-500',
  'bg-purple-500',
  'bg-blue-500',
  'bg-teal-500',
];

export default async function EventPage({ params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  let eventDetail: EventDetailResponse | undefined;

  try {
    eventDetail = await getEvent(hash);
  } catch (_error) {
    return (
      <div className="max-w-5xl mx-auto py-8">
        <ErrorState message="Failed to load the event timeline." />
      </div>
    );
  }

  if (!eventDetail.success || !eventDetail.data) {
    return (
      <div className="max-w-5xl mx-auto py-8 text-center">
        <EmptyState title="Event Not Found" message="This event does not exist or has been removed." />
        <Link href="/" className="mt-4 inline-block text-indigo-600 hover:text-indigo-800 dark:text-indigo-400">
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

  // Formatted date string for first and last report
  const firstReportFormatted = coverage?.first_published_at
    ? new Date(coverage.first_published_at * 1000).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : 'Unknown';

  const lastReportFormatted = event.last_published_at
    ? new Date(event.last_published_at * 1000).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'Unknown';

  // Cap topic display at 16, track overflow count
  const TOPIC_DISPLAY_LIMIT = 16;
  const displayedTopics = intelligence?.unique_topics?.slice(0, TOPIC_DISPLAY_LIMIT) ?? [];
  const hiddenTopicCount = Math.max(0, (intelligence?.unique_topics?.length ?? 0) - TOPIC_DISPLAY_LIMIT);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6">
      {/* ── Breadcrumb Navigation ────────────────────────────────────── */}
      <nav className="flex items-center gap-3 mb-6" aria-label="Breadcrumb">
        <Link
          href="/"
          className="inline-flex items-center text-sm font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded"
        >
          <ChevronLeftIcon className="w-4 h-4 mr-1" />
          Feed
        </Link>
        <span className="text-gray-300 dark:text-gray-700" aria-hidden="true">/</span>
        <Link
          href="/events"
          className="text-sm font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded"
        >
          Event Radar
        </Link>
        <span className="text-gray-300 dark:text-gray-700" aria-hidden="true">/</span>
        <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate max-w-xs" aria-current="page">
          {event.title}
        </span>
      </nav>

      {/* ── 1. Event Overview & Title ──────────────────────────────── */}
      <header className="mb-8 pb-6 border-b border-gray-200 dark:border-gray-800">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wide ${severityBadgeClasses(event.severity)}`}>
            {event.severity}
          </span>
          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${freshnessBadgeClasses(event.freshness)}`}>
            {event.freshness === 'developing' && (
              <span className="relative flex h-2 w-2 mr-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
            )}
            {event.freshness.toUpperCase()}
          </span>
          {intelligence?.top_source && (
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border border-gray-200 dark:border-gray-700">
              Lead Source: {intelligence.top_source}
            </span>
          )}
        </div>

        <h1 className="text-3xl sm:text-4xl font-extrabold text-gray-900 dark:text-gray-100 mb-3 tracking-tight">
          {event.title}
        </h1>

        {event.description && (
          <p className="text-lg text-gray-600 dark:text-gray-300 leading-relaxed max-w-4xl mb-6">
            {event.description}
          </p>
        )}

        {/* Telemetry HUD Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <div className="p-3.5 bg-gray-50 dark:bg-gray-850 rounded-xl border border-gray-200 dark:border-gray-800">
            <span className="text-[11px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider block">
              Total Articles
            </span>
            <span className="text-2xl font-black text-gray-900 dark:text-gray-100 mt-0.5 block font-mono">
              {coverage?.total_articles ?? articles.length}
            </span>
          </div>

          <div className="p-3.5 bg-gray-50 dark:bg-gray-850 rounded-xl border border-gray-200 dark:border-gray-800">
            <span className="text-[11px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider block">
              Sources Reporting
            </span>
            <span className="text-2xl font-black text-gray-900 dark:text-gray-100 mt-0.5 block font-mono">
              {coverage?.total_sources ?? '—'}
            </span>
          </div>

          <div className="p-3.5 bg-gray-50 dark:bg-gray-850 rounded-xl border border-gray-200 dark:border-gray-800">
            <span className="text-[11px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider block">
              Days Active
            </span>
            <span className="text-2xl font-black text-gray-900 dark:text-gray-100 mt-0.5 block font-mono">
              {intelligence?.days_active !== null && intelligence?.days_active !== undefined
                ? intelligence.days_active
                : 1}
            </span>
          </div>

          <div className="p-3.5 bg-gray-50 dark:bg-gray-850 rounded-xl border border-gray-200 dark:border-gray-800">
            <span className="text-[11px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider block">
              Coverage Density
            </span>
            <span className="text-2xl font-black text-indigo-600 dark:text-indigo-400 mt-0.5 block font-mono">
              {intelligence?.coverage_density !== null && intelligence?.coverage_density !== undefined
                ? `${intelligence.coverage_density}/d`
                : '—'}
            </span>
          </div>

          <div className="p-3.5 bg-gray-50 dark:bg-gray-850 rounded-xl border border-gray-200 dark:border-gray-800">
            <span className="text-[11px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider block">
              First Report
            </span>
            <span className="text-xs font-bold text-gray-800 dark:text-gray-200 mt-1 block truncate" title={firstReportFormatted}>
              {firstReportFormatted}
            </span>
          </div>

          <div className="p-3.5 bg-gray-50 dark:bg-gray-850 rounded-xl border border-gray-200 dark:border-gray-800">
            <span className="text-[11px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider block">
              Latest Activity
            </span>
            <span className="text-xs font-bold text-gray-800 dark:text-gray-200 mt-1 block truncate" title={lastReportFormatted}>
              {lastCoverageDisplay ?? lastReportFormatted}
            </span>
          </div>
        </div>
      </header>

      {/* ── 2. Freshness / Lifecycle Banner ──────────────────────────── */}
      <section
        aria-label="Story freshness status"
        className={`mb-8 px-5 py-3.5 rounded-xl border text-sm leading-relaxed flex items-center gap-3 ${freshnessClasses(event.freshness)}`}
      >
        <ActivityIcon className="w-5 h-5 shrink-0" />
        <div>
          <span className="font-bold capitalize">{event.freshness} Status:</span>{' '}
          {freshnessLabel(event.freshness)}
        </div>
      </section>

      {/* ── 3. What Changed? / Story Evolution Intelligence Panel ──── */}
      <section
        aria-label="Story evolution intelligence"
        className="mb-8 p-6 bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-sm"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <RadarIcon className="w-5 h-5 text-indigo-500 shrink-0" />
            What Changed? — Story Evolution Intelligence
          </h2>
          <span className="text-xs text-gray-500 dark:text-gray-400 font-mono">
            {coverage?.total_articles} articles &middot; {coverage?.total_sources} newsrooms
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="p-4 bg-gray-50 dark:bg-gray-850 rounded-lg border border-gray-200 dark:border-gray-800">
            <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1">
              Coverage Velocity
            </div>
            <div className="text-base font-bold text-gray-900 dark:text-gray-100">
              {intelligence?.coverage_density ?? 1} articles per day
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Active across {intelligence?.days_active ?? 1} calendar day{intelligence?.days_active !== 1 ? 's' : ''} since initial reporting.
            </p>
          </div>

          <div className="p-4 bg-gray-50 dark:bg-gray-850 rounded-lg border border-gray-200 dark:border-gray-800">
            <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1">
              Newsroom Consensus
            </div>
            <div className="text-base font-bold text-gray-900 dark:text-gray-100">
              {coverage?.total_sources} Distinct Newsrooms
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {intelligence?.top_source ? (
                <>Top contributor: <span className="font-semibold text-gray-700 dark:text-gray-300">{intelligence.top_source}</span></>
              ) : (
                'Cross-checked across global feeds.'
              )}
            </p>
          </div>

          <div className="p-4 bg-gray-50 dark:bg-gray-850 rounded-lg border border-gray-200 dark:border-gray-800">
            <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1">
              Thematic Breadth
            </div>
            <div className="text-base font-bold text-gray-900 dark:text-gray-100">
              {intelligence?.topic_count ?? displayedTopics.length} Topics Tracked
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Extracted entities and semantic tags mapped across reporting.
            </p>
          </div>
        </div>

        {/* Topics Introduced Across Story */}
        {displayedTopics.length > 0 && (
          <div>
            <h3 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2.5">
              Thematic Topics Detected in Coverage
            </h3>
            <div className="flex flex-wrap gap-2">
              {displayedTopics.map((topic) => (
                <Link
                  key={topic}
                  href={`/topics?q=${encodeURIComponent(topic)}`}
                  className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-500/10 dark:hover:bg-indigo-500/20 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-500/20 transition-colors"
                >
                  #{topic}
                </Link>
              ))}
              {hiddenTopicCount > 0 && (
                <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700">
                  +{hiddenTopicCount} more topics
                </span>
              )}
            </div>
          </div>
        )}
      </section>

      {/* ── 4. Source Diversity Breakdown ──────────────────────────── */}
      {coverage && coverage.sources && coverage.sources.length > 0 && (
        <section
          aria-label="Source diversity breakdown"
          className="mb-10 p-6 bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-sm"
        >
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
              <TrendingUpIcon className="w-5 h-5 text-indigo-500 shrink-0" />
              Source Diversity Breakdown
            </h2>
            <span className="text-xs text-gray-500 dark:text-gray-400 font-mono">
              {coverage.total_sources} sources &middot; {coverage.total_articles} reports
            </span>
          </div>

          {/* Visual Source Distribution Bar */}
          <div className="mb-6">
            <div className="h-3.5 w-full bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden flex shadow-inner">
              {coverage.sources.map((src, index) => {
                const pct = coverage.total_articles > 0
                  ? (src.article_count / coverage.total_articles) * 100
                  : 0;
                const color = SOURCE_COLORS[index % SOURCE_COLORS.length];
                return (
                  <div
                    key={src.name}
                    className={`${color} h-full transition-all duration-300`}
                    style={{ width: `${pct}%` }}
                    title={`${src.name}: ${src.article_count} articles (${Math.round(pct)}%)`}
                  />
                );
              })}
            </div>
          </div>

          {/* Source Cards Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {coverage.sources.map((src, index) => {
              const pct = coverage.total_articles > 0
                ? Math.round((src.article_count / coverage.total_articles) * 100)
                : 0;
              const colorDot = SOURCE_COLORS[index % SOURCE_COLORS.length];
              const firstSourceDate = src.first_published_at
                ? new Date(src.first_published_at * 1000).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                  })
                : null;

              return (
                <div
                  key={src.name}
                  className="flex items-center justify-between p-3 rounded-lg bg-gray-50 dark:bg-gray-850 border border-gray-200 dark:border-gray-800"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className={`w-2.5 h-2.5 rounded-full ${colorDot} shrink-0`} aria-hidden="true" />
                    <div className="min-w-0">
                      <span className="text-xs font-bold text-gray-900 dark:text-gray-100 truncate block">
                        {src.name}
                      </span>
                      {firstSourceDate && (
                        <span className="text-[11px] text-gray-400 dark:text-gray-500 font-mono">
                          First: {firstSourceDate}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-right shrink-0 ml-2">
                    <span className="text-xs font-mono font-bold text-gray-900 dark:text-gray-100">
                      {src.article_count} {src.article_count === 1 ? 'article' : 'articles'}
                    </span>
                    <span className="text-[10px] text-gray-400 font-mono block">
                      ({pct}%)
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ── 5. Story Evolution Timeline ────────────────────────────── */}
      <section aria-label="Story evolution timeline">
        <EventTimeline
          articles={articles}
          totalArticles={coverage?.total_articles}
        />
      </section>
    </div>
  );
}
