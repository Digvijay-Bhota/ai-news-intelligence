'use client';

import React, { useState, useEffect, Suspense, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { fetchActiveEvents } from '../../lib/api';
import type { EventSummary, GlobalFreshnessSummary } from '../../types';
import { EventCard } from '../../components/EventCard';
import { RadarIcon, ActivityIcon } from '../../components/icons';

function EmptyState({ title, message }: { title: string; message: string }) {
  return (
    <div className="bg-white dark:bg-gray-900 p-12 rounded-xl shadow-sm border border-gray-200 dark:border-gray-800 text-center">
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
  const [summary, setSummary] = useState<GlobalFreshnessSummary | null>(null);
  const [userPrefs, setUserPrefs] = useState<{ preferred_topics: string[]; preferred_sources: string[] } | null>(null);
  const [filterMatchedOnly, setFilterMatchedOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Load active events
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

  // Load user preferences for personalization
  useEffect(() => {
    async function loadPreferences() {
      try {
        const res = await fetch('/api/preferences');
        if (res.ok) {
          const json = await res.json();
          if (json.success && json.data) {
            setUserPrefs({
              preferred_topics: json.data.preferred_topics || [],
              preferred_sources: json.data.preferred_sources || [],
            });
          }
        }
      } catch (_err) {
        // Silently continue if preferences fail to load
      }
    }
    loadPreferences();
  }, []);

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
    setFilterMatchedOnly(false);
    router.push(pathname);
  };

  const getMatchReason = useCallback((event: EventSummary): string | null => {
    if (!userPrefs || (!userPrefs.preferred_topics.length && !userPrefs.preferred_sources.length)) {
      return null;
    }
    const text = `${event.title} ${event.description || ''}`.toLowerCase();
    for (const topic of userPrefs.preferred_topics) {
      if (text.includes(topic.toLowerCase())) {
        return `Following ${topic}`;
      }
    }
    return null;
  }, [userPrefs]);

  const displayedEvents = useMemo(() => {
    if (!filterMatchedOnly) return events;
    return events.filter(e => !!getMatchReason(e));
  }, [events, filterMatchedOnly, getMatchReason]);

  const matchedCount = useMemo(() => {
    if (!userPrefs) return 0;
    return events.filter(e => !!getMatchReason(e)).length;
  }, [events, userPrefs, getMatchReason]);

  const hasActiveFilters = currentFreshness || currentSeverity || currentMinArticles || currentSort !== 'priority' || filterMatchedOnly;

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
      {/* Header & Global Telemetry HUD */}
      <header className="mb-8">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="flex h-2 w-2 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-600 dark:bg-indigo-400"></span>
              </span>
              <span className="text-xs font-bold uppercase tracking-wider text-indigo-700 dark:text-indigo-400 font-mono flex items-center gap-1.5">
                <RadarIcon className="w-3.5 h-3.5" />
                Event Intelligence Engine
              </span>
              <span className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                Real-Time Synthesis
              </span>
            </div>
            <h1 className="text-3xl sm:text-4xl font-black text-gray-900 dark:text-gray-50 tracking-tight">
              Top Global Events
            </h1>
            <p className="text-base sm:text-lg text-gray-600 dark:text-gray-400 max-w-3xl mt-1">
              Automated multi-source story clusters ranked by coverage velocity, freshness, and severity.
            </p>
          </div>

          {/* HUD Telemetry Strip */}
          {summary && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono bg-white dark:bg-gray-900 p-3.5 rounded-xl border border-gray-200 dark:border-gray-800 shadow-sm self-start sm:self-auto">
              <div className="px-2">
                <div className="text-gray-400 dark:text-gray-500 uppercase tracking-wide text-[10px]">Total Events</div>
                <div className="text-lg font-bold text-gray-900 dark:text-gray-100">{summary.total}</div>
              </div>
              <div className="px-2 border-l border-gray-100 dark:border-gray-800">
                <div className="text-emerald-500 uppercase tracking-wide text-[10px]">Developing</div>
                <div className="text-lg font-bold text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                  {summary.developing}
                </div>
              </div>
              <div className="px-2 border-l border-gray-100 dark:border-gray-800">
                <div className="text-indigo-500 uppercase tracking-wide text-[10px]">Active</div>
                <div className="text-lg font-bold text-indigo-600 dark:text-indigo-400">{summary.active}</div>
              </div>
              <div className="px-2 border-l border-gray-100 dark:border-gray-800">
                <div className="text-gray-400 uppercase tracking-wide text-[10px]">Concluded</div>
                <div className="text-lg font-bold text-gray-500 dark:text-gray-400">{summary.stale}</div>
              </div>
            </div>
          )}
        </div>
      </header>

      {/* Interactive Intelligence Filter Bar */}
      <div className="mb-8 p-4 bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-sm flex flex-wrap gap-4 items-end">
        <div>
          <label htmlFor="freshness-select" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Freshness</label>
          <select
            id="freshness-select"
            value={currentFreshness}
            onChange={(e) => setFilter('freshness', e.target.value)}
            className="block w-full sm:w-36 rounded-md border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 text-sm dark:text-gray-100 py-1.5 px-2.5"
          >
            <option value="">All Statuses</option>
            <option value="developing">Developing</option>
            <option value="active">Active</option>
            <option value="stale">Concluded</option>
          </select>
        </div>

        <div>
          <label htmlFor="severity-select" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Severity</label>
          <select
            id="severity-select"
            value={currentSeverity}
            onChange={(e) => setFilter('severity', e.target.value)}
            className="block w-full sm:w-36 rounded-md border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 text-sm dark:text-gray-100 py-1.5 px-2.5"
          >
            <option value="">All Severities</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="warning">Warning</option>
            <option value="medium">Medium</option>
            <option value="info">Info</option>
            <option value="low">Low</option>
          </select>
        </div>

        <div>
          <label htmlFor="min-articles-input" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Min Articles</label>
          <input
            id="min-articles-input"
            type="number"
            min="0"
            value={currentMinArticles}
            onChange={(e) => setFilter('min_articles', e.target.value)}
            placeholder="0"
            className="block w-full sm:w-28 rounded-md border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 text-sm dark:text-gray-100 py-1.5 px-2.5"
          />
        </div>

        <div>
          <label htmlFor="sort-select" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Ranking</label>
          <select
            id="sort-select"
            value={currentSort}
            onChange={(e) => setFilter('sort', e.target.value)}
            className="block w-full sm:w-36 rounded-md border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 text-sm dark:text-gray-100 py-1.5 px-2.5"
          >
            <option value="priority">Priority Score</option>
            <option value="recent">Latest Report</option>
            <option value="coverage">Article Volume</option>
          </select>
        </div>

        {/* Personalized "Matches My Interests" Quick Filter */}
        {userPrefs && (userPrefs.preferred_topics.length > 0 || userPrefs.preferred_sources.length > 0) && (
          <button
            onClick={() => setFilterMatchedOnly(!filterMatchedOnly)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors flex items-center gap-1.5 ${
              filterMatchedOnly
                ? 'bg-purple-100 border-purple-300 text-purple-800 dark:bg-purple-900/40 dark:border-purple-700 dark:text-purple-300'
                : 'border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
            }`}
          >
            <span>🎯</span>
            <span>Matched My Interests</span>
            {matchedCount > 0 && (
              <span className="ml-1 px-1.5 py-0.2 rounded-full text-[10px] bg-purple-200 dark:bg-purple-800 text-purple-900 dark:text-purple-200">
                {matchedCount}
              </span>
            )}
          </button>
        )}

        {hasActiveFilters && (
          <div className="ml-auto">
            <button
              onClick={clearFilters}
              className="px-3 py-1.5 border border-gray-300 dark:border-gray-700 rounded-md text-xs font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              Reset Filters
            </button>
          </div>
        )}
      </div>

      {/* Events Stream */}
      {loading ? (
        <div className="space-y-4">
          <div className="h-44 bg-gray-100 dark:bg-gray-800/60 rounded-xl animate-pulse" />
          <div className="h-44 bg-gray-100 dark:bg-gray-800/60 rounded-xl animate-pulse" />
          <div className="h-44 bg-gray-100 dark:bg-gray-800/60 rounded-xl animate-pulse" />
        </div>
      ) : error ? (
        <div className="p-12 text-center bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800">
          <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">Failed to load events</h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Could not retrieve active events at this time.</p>
        </div>
      ) : displayedEvents.length === 0 ? (
        <EmptyState
          title={filterMatchedOnly ? "No Events Match Your Followed Topics" : "No Events Found"}
          message={filterMatchedOnly ? "None of the currently tracked events match your active topic preferences. Try resetting filters." : "Try adjusting your filter criteria to see more event clusters."}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {displayedEvents.map((event) => (
            <EventCard
              key={event.hash}
              event={event}
              matchedReason={getMatchReason(event)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function EventsDashboard() {
  return (
    <Suspense fallback={
      <div className="space-y-6 max-w-6xl mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-extrabold text-gray-900 dark:text-gray-50 tracking-tight mb-2">Top Global Events</h1>
          <p className="text-lg text-gray-600 dark:text-gray-400">Loading active global events...</p>
        </div>
      </div>
    }>
      <EventsDashboardInner />
    </Suspense>
  );
}
