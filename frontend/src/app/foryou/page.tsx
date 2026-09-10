'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Feed } from '../../components/Feed';
import { EventCard } from '../../components/EventCard';
import type { PersonalizedFeedItem } from '../../types';
import { RadarIcon, ChevronRightIcon } from '../../components/icons';
import Link from 'next/link';

interface FeedData {
  items: PersonalizedFeedItem[];
  meta: {
    total: number;
    limit: number;
    offset: number;
    user_has_follows: boolean;
    fallback_applied: boolean;
  };
}

export default function ForYouPage() {
  const [feedData, setFeedData] = useState<FeedData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadFeed = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/feed/for-you?limit=20');
      if (!res.ok) {
        throw new Error(`Failed to load feed (${res.status})`);
      }
      const json = await res.json();
      if (json.success && json.data) {
        setFeedData(json.data);
      } else {
        throw new Error(json.error || 'Failed to parse feed response');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Error fetching /api/feed/for-you:', msg);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFeed();
  }, [loadFeed]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="mb-8">
          <h2 className="text-3xl font-bold text-gray-900 dark:text-gray-100 tracking-tight">For You</h2>
          <p className="mt-2 text-lg text-gray-600 dark:text-gray-400">Loading your personalized intelligence briefing...</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="h-48 bg-gray-100 dark:bg-gray-800 rounded-xl animate-pulse"></div>
          <div className="h-48 bg-gray-100 dark:bg-gray-800 rounded-xl animate-pulse"></div>
        </div>
        <div className="h-64 bg-gray-100 dark:bg-gray-800 rounded-xl animate-pulse mt-6"></div>
      </div>
    );
  }

  if (error || !feedData) {
    return (
      <div className="max-w-3xl py-12 text-center bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-8 shadow-sm">
        <p className="text-red-500 font-medium mb-4">Unable to load personalized feed: {error || 'Unknown error'}</p>
        <div className="flex items-center justify-center gap-4">
          <button
            onClick={() => loadFeed()}
            className="px-4 py-2 text-sm font-semibold rounded-lg text-white bg-indigo-600 hover:bg-indigo-700 transition-colors shadow-sm"
          >
            Try Again
          </button>
          <Link
            href="/events"
            className="px-4 py-2 text-sm font-semibold rounded-lg text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
          >
            Browse All Events
          </Link>
        </div>
      </div>
    );
  }

  const { items, meta } = feedData;
  const hasFollows = meta.user_has_follows;
  const isFallback = meta.fallback_applied;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-3xl font-bold text-gray-900 dark:text-gray-100 tracking-tight">For You</h2>
          <p className="mt-1 text-base text-gray-600 dark:text-gray-400">
            {hasFollows && !isFallback
              ? 'Curated intelligence stream matching your followed topics, sources, and tracked events.'
              : hasFollows && isFallback
                ? 'Top developing intelligence stories while awaiting new updates on your followed interests.'
                : 'Top developing intelligence stories. Follow topics, sources, or events to tailor this briefing.'}
          </p>
        </div>
        <Link
          href="/settings"
          className="inline-flex items-center text-xs font-semibold text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300"
        >
          Manage Follows & Interests &rarr;
        </Link>
      </div>

      {/* No Follows Discovery Banner (Cold Start) */}
      {!hasFollows && (
        <div className="bg-indigo-50/70 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-800/50 rounded-xl p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg bg-indigo-100 dark:bg-indigo-900/50 text-indigo-600 dark:text-indigo-400 mt-0.5">
              <RadarIcon className="w-5 h-5" />
            </div>
            <div>
              <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                Personalize your intelligence briefing
              </h4>
              <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">
                You are currently viewing canonical active stories. Follow topics, news outlets, or specific events to elevate what matters most to you.
              </p>
            </div>
          </div>
          <Link
            href="/topics"
            className="whitespace-nowrap px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors shadow-sm"
          >
            Explore Topics &rarr;
          </Link>
        </div>
      )}

      {/* Follows Exist but No Direct Candidate Matches Banner */}
      {hasFollows && isFallback && (
        <div className="bg-amber-50/70 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/50 rounded-xl p-4 flex items-center justify-between gap-4">
          <p className="text-xs text-amber-800 dark:text-amber-300">
            <span className="font-semibold">Catch-up briefing:</span> None of your followed topics or sources have fresh event activity today. Displaying top active cluster intelligence instead.
          </p>
          <Link
            href="/settings"
            className="text-xs font-semibold text-amber-700 hover:text-amber-900 dark:text-amber-400 whitespace-nowrap"
          >
            View Follows &rarr;
          </Link>
        </div>
      )}

      {/* Ranked Events Section */}
      {items.length > 0 && (
        <section aria-label="Personalized events" className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="flex h-2 w-2 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-600 dark:bg-indigo-400"></span>
              </span>
              <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
                <RadarIcon className="w-4 h-4 text-indigo-500" />
                {hasFollows && !isFallback ? 'Events Matching Your Profile' : 'Top Event Intelligence'}
              </h3>
              <span className="text-xs font-bold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-500/10 px-2 py-0.5 rounded-full border border-indigo-200 dark:border-indigo-500/20 font-mono">
                {items.length}
              </span>
            </div>
            <Link
              href="/events"
              className="text-xs font-medium text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 flex items-center gap-0.5"
            >
              View All Events
              <ChevronRightIcon className="w-3.5 h-3.5" />
            </Link>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {items.map(item => (
              <EventCard
                key={item.hash || `ev-${item.id}`}
                event={item}
                rankReasons={item.rank_reasons}
                briefVersion={item.brief_version}
                score={item.score}
              />
            ))}
          </div>
        </section>
      )}

      {/* Personalized Articles Feed */}
      <section aria-label="Personalized article stream" className="space-y-4 pt-4">
        <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">
          Latest Article Stream
        </h3>
        <Feed />
      </section>
    </div>
  );
}
