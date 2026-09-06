'use client';

import React, { useState, useEffect, Suspense, useCallback } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { fetchActiveEvents } from '../../lib/api';
import type { EventSummary } from '../../types';

function EmptyState({ title, message }: { title: string; message: string }) {
  return (
    <div className="bg-white p-12 rounded-xl shadow-sm border border-gray-200 text-center dark:bg-gray-900 dark:border-gray-800">
      <h3 className="text-xl font-semibold text-gray-900 mb-2 dark:text-gray-100">{title}</h3>
      <p className="text-gray-600 dark:text-gray-400">{message}</p>
    </div>
  );
}

function EventsDashboardInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const currentFreshness = searchParams.get('freshness') || '';
  const currentSeverity = searchParams.get('severity') || '';
  const currentMinArticles = searchParams.get('min_articles') || '';
  const currentSort = searchParams.get('sort') || 'priority';

  const [events, setEvents] = useState<EventSummary[]>([]);
  const [summary, setSummary] = useState<import('../../types').GlobalFreshnessSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchActiveEvents({
        freshness: currentFreshness || undefined,
        severity: currentSeverity || undefined,
        min_articles: currentMinArticles ? parseInt(currentMinArticles, 10) : undefined,
        sort: currentSort !== 'priority' ? currentSort : undefined
      });
      if (res.success) {
        setEvents(res.data.items);
        setSummary(res.data.summary);
      } else {
        setError(true);
      }
    } catch (err) {
      console.error(err);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [currentFreshness, currentSeverity, currentMinArticles, currentSort]);

  useEffect(() => {
    load();
  }, [load]);

  const setFilter = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    router.push(pathname + '?' + params.toString());
  };

  const clearFilters = () => {
    router.push(pathname);
  };

  const hasFilters = currentFreshness || currentSeverity || currentMinArticles || currentSort !== 'priority';

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
      <header className="mb-8">
        <h1 className="text-3xl sm:text-4xl font-extrabold text-gray-900 dark:text-gray-50 tracking-tight mb-3">
          Top Events
        </h1>
        <p className="text-lg text-gray-600 dark:text-gray-400 max-w-3xl mb-4">
          The most critical unfolding stories tracked by AI News Intelligence.
        </p>

        {summary && (
          <div className="flex flex-wrap gap-4 text-sm text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 p-4 rounded-lg border border-gray-200 dark:border-gray-800">
            <div className="font-semibold text-gray-900 dark:text-gray-100">Global Overview:</div>
            <div><span className="font-medium text-gray-900 dark:text-gray-100">{summary.total}</span> Total</div>
            <div><span className="font-medium text-indigo-600 dark:text-indigo-400">{summary.developing}</span> Developing</div>
            <div><span className="font-medium text-green-600 dark:text-green-400">{summary.active}</span> Active</div>
            <div><span className="font-medium text-gray-500 dark:text-gray-500">{summary.stale}</span> Stale</div>
          </div>
        )}
      </header>

      <div className="mb-8 p-4 bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-sm flex flex-wrap gap-4 items-end">
        <div>
          <label htmlFor="freshness-select" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Freshness</label>
          <select
            id="freshness-select"
            value={currentFreshness}
            onChange={(e) => setFilter('freshness', e.target.value)}
            className="block w-full sm:w-40 rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100"
          >
            <option value="">All</option>
            <option value="developing">Developing</option>
            <option value="active">Active</option>
            <option value="stale">Stale</option>
          </select>
        </div>

        <div>
          <label htmlFor="severity-select" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Severity</label>
          <select
            id="severity-select"
            value={currentSeverity}
            onChange={(e) => setFilter('severity', e.target.value)}
            className="block w-full sm:w-40 rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100"
          >
            <option value="">All</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="warning">Warning</option>
            <option value="medium">Medium</option>
            <option value="info">Info</option>
            <option value="low">Low</option>
          </select>
        </div>

        <div>
          <label htmlFor="min-articles-input" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Min Coverage</label>
          <input
            id="min-articles-input"
            type="number"
            min="0"
            value={currentMinArticles}
            onChange={(e) => setFilter('min_articles', e.target.value)}
            placeholder="0"
            className="block w-full sm:w-32 rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100"
          />
        </div>

        <div>
          <label htmlFor="sort-select" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Sort</label>
          <select
            id="sort-select"
            value={currentSort}
            onChange={(e) => setFilter('sort', e.target.value)}
            className="block w-full sm:w-40 rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100"
          >
            <option value="priority">Priority</option>
            <option value="recent">Recent</option>
            <option value="coverage">Coverage</option>
          </select>
        </div>

        {hasFilters && (
          <div className="ml-auto">
            <button
              onClick={clearFilters}
              className="px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-md text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              Clear Filters
            </button>
          </div>
        )}
      </div>

      {loading ? (
        <div className="space-y-4">
          <div className="h-32 bg-gray-100 dark:bg-gray-800 rounded-xl animate-pulse" />
          <div className="h-32 bg-gray-100 dark:bg-gray-800 rounded-xl animate-pulse" />
          <div className="h-32 bg-gray-100 dark:bg-gray-800 rounded-xl animate-pulse" />
        </div>
      ) : error ? (
        <div className="max-w-5xl mx-auto px-4 py-12 text-center">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Failed to load events</h1>
          <p className="mt-2 text-gray-600 dark:text-gray-400">Could not retrieve active events at this time.</p>
        </div>
      ) : events.length === 0 ? (
        <EmptyState title="No Events Found" message="Try adjusting your filters or clearing them to see more events." />
      ) : (
        <div className="space-y-6">
          {events.map((event) => {
            const isCritical = event.severity === 'critical';
            const isWarning = event.severity === 'high' || event.severity === 'warning';
            
            const badgeColor = isCritical
              ? 'bg-red-100 text-red-800 border-red-200 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/20'
              : isWarning
                ? 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/20'
                : 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-500/10 dark:text-blue-300 dark:border-blue-500/20';

            const dotColor = isCritical ? 'bg-red-500' : isWarning ? 'bg-amber-500' : 'bg-blue-500';

            return (
              <Link 
                key={event.hash}
                href={`/events/${event.hash}`}
                className="block group"
              >
                <div className={`bg-white dark:bg-gray-900 rounded-xl shadow-sm hover:shadow-md transition-all duration-200 border border-gray-200 dark:border-gray-800 hover:border-indigo-300 dark:hover:border-gray-700 p-6 flex flex-col sm:flex-row sm:items-start gap-4 ${event.freshness === 'stale' ? 'opacity-70 grayscale-[20%]' : ''}`}>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-3 mb-3">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${badgeColor}`}>
                        <span className={`w-1.5 h-1.5 rounded-full mr-1.5 ${dotColor}`} aria-hidden="true"></span>
                        {(event.severity || 'info').toUpperCase()}
                        {event.freshness && (
                          <>
                            <span className="mx-1.5 opacity-50">&middot;</span>
                            {event.freshness.toUpperCase()}
                          </>
                        )}
                      </span>
                      {event.last_published_at ? (
                        <span className="text-sm text-gray-500 dark:text-gray-400">
                          {new Date(event.last_published_at * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                        </span>
                      ) : (
                        <span className="text-sm text-gray-500 dark:text-gray-400">
                          Time unavailable
                        </span>
                      )}
                    </div>
                    
                    <h2 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                      {event.title}
                    </h2>
                    
                    {event.description && (
                      <p className="text-gray-600 dark:text-gray-300 line-clamp-2 leading-relaxed">
                        {event.description}
                      </p>
                    )}
                  </div>
                  
                  <div className="sm:ml-4 sm:pl-6 sm:border-l border-gray-100 dark:border-gray-800 flex flex-row sm:flex-col items-center sm:items-end justify-between sm:justify-start gap-4 flex-shrink-0 mt-4 sm:mt-0">
                    <div className="text-center sm:text-right">
                      <span className="block text-2xl font-extrabold text-indigo-600 dark:text-indigo-400">
                        {event.article_count}
                      </span>
                      <span className="block text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mt-1">
                        Coverage
                      </span>
                    </div>
                    
                    <span className="inline-flex items-center text-sm font-medium text-indigo-600 dark:text-indigo-400 group-hover:text-indigo-800 dark:group-hover:text-indigo-300">
                      View Timeline <span aria-hidden="true" className="ml-1">&rarr;</span>
                    </span>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function EventsDashboard() {
  return (
    <Suspense fallback={
      <div className="space-y-6 max-w-5xl mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-extrabold text-gray-900 dark:text-gray-50 tracking-tight mb-2">Global Intelligence</h1>
          <p className="text-lg text-gray-600 dark:text-gray-400">Loading active global events...</p>
        </div>
      </div>
    }>
      <EventsDashboardInner />
    </Suspense>
  );
}
