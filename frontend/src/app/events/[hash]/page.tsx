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

export default async function EventPage({ params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  let eventDetail;

  try {
    eventDetail = await getEvent(hash);
  } catch (error) {
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

  const { event, coverage, articles } = eventDetail.data;

  return (
    <div className="max-w-4xl mx-auto">
      <Link href="/" className="inline-flex items-center text-sm font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300 mb-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded">
        <ChevronLeftIcon className="w-4 h-4 mr-1" />
        Back to Feed
      </Link>

      <header className="mb-10 pb-6 border-b border-gray-200 dark:border-gray-800">
        <div className="flex items-center gap-3 mb-3">
          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium uppercase tracking-wide ${
            event.severity === 'critical' ? 'bg-red-100 text-red-800 dark:bg-red-500/10 dark:text-red-400' :
            event.severity === 'warning' ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-500/10 dark:text-yellow-400' :
            'bg-blue-100 text-blue-800 dark:bg-blue-500/10 dark:text-blue-400'
          }`}>
            {event.severity}
          </span>
          {event.started_at && (
            <time className="text-sm text-gray-500 dark:text-gray-400">
              Started {new Date(event.started_at * 1000).toLocaleDateString()}
            </time>
          )}
        </div>
        <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-4 tracking-tight">
          {event.title}
        </h1>
        {event.description && (
          <p className="text-lg text-gray-600 dark:text-gray-300 leading-relaxed max-w-3xl">
            {event.description}
          </p>
        )}
      </header>

      {coverage && (
        <section className="mb-10 p-6 bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4 flex items-center">
            <svg className="w-5 h-5 mr-2 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9.5a2.5 2.5 0 00-2.5-2.5H15" />
            </svg>
            Coverage Summary
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
            <div className="flex flex-col">
              <span className="text-sm font-medium text-gray-500 dark:text-gray-400">Total Sources</span>
              <span className="text-2xl font-bold text-gray-900 dark:text-gray-100">{coverage.total_sources}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-medium text-gray-500 dark:text-gray-400">Total Articles</span>
              <span className="text-2xl font-bold text-gray-900 dark:text-gray-100">{coverage.total_articles}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-medium text-gray-500 dark:text-gray-400">First Report</span>
              <span className="text-lg font-medium text-gray-900 dark:text-gray-100">
                {coverage.first_published_at ? new Date(coverage.first_published_at * 1000).toLocaleDateString() : 'Unknown'}
              </span>
            </div>
          </div>
          <div>
            <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-3">Sources Covering This Event</h3>
            <div className="flex flex-wrap gap-2">
              {coverage.sources.map((src) => (
                <span key={src.name} className="inline-flex items-center px-2.5 py-1 rounded-md text-sm bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-700">
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

      {articles.length === 0 ? (
        <EmptyState title="No articles found" message="There are no articles associated with this event timeline." />
      ) : (
        <div className="relative">
          {/* Vertical timeline line for desktop/tablet */}
          <div className="hidden md:block absolute left-8 top-0 bottom-0 w-px bg-gray-200 dark:bg-gray-800" />

          <div className="space-y-12">
            {Object.entries(
              articles.reduce((acc, article, index) => {
                const isBreaking = index === 0;

                // Track source
                if (!acc.seenSources) acc.seenSources = new Set();
                const isFirstForSource = !acc.seenSources.has(article.source);
                if (isFirstForSource) acc.seenSources.add(article.source);

                // Track topics
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
                  ? new Date(article.published_at * 1000).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
                  : 'Unknown Date';

                if (!acc.groups) acc.groups = {};
                if (!acc.groups[dateStr]) acc.groups[dateStr] = [];

                acc.groups[dateStr].push({ ...article, isBreaking, isFirstForSource, newTopics });
                return acc;
              }, { seenSources: new Set<string>(), seenTopics: new Set<string>(), groups: {} as Record<string, any[]> }).groups
            ).map(([dateStr, dayArticles]) => (
              <div key={dateStr} className="relative">
                {/* Date Header */}
                <div className="sticky top-4 z-10 mb-8 md:pl-20 flex items-center">
                  <div className="hidden md:flex absolute left-8 -translate-x-1/2 w-6 h-6 rounded-full bg-white dark:bg-gray-900 border-4 border-gray-200 dark:border-gray-800 items-center justify-center z-10" />
                  <h3 className="inline-flex items-center px-4 py-1.5 rounded-full text-sm font-bold bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-gray-700 shadow-sm">
                    {dateStr}
                  </h3>
                </div>

                <div className="space-y-8">
                  {dayArticles.map((article) => (
                    <div key={article.id} className="relative md:pl-20">
                      {/* Timeline node */}
                      <div className="hidden md:flex absolute left-8 -translate-x-1/2 top-6 w-4 h-4 rounded-full bg-indigo-100 dark:bg-indigo-900/50 border-2 border-indigo-500 items-center justify-center">
                        <div className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
                      </div>

                      {/* Badges */}
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

          {coverage && articles.length < coverage.total_articles && (
            <div className="mt-8 md:pl-20">
              <div className="p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg text-center border border-gray-200 dark:border-gray-800">
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Showing newly appearing topics and early coverage evolution across the first {articles.length} articles of {coverage.total_articles} total.
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
