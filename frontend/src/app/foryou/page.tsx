'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Feed } from '../../components/Feed';
import { EventCard } from '../../components/EventCard';
import type { PersonalizedFeedItem } from '../../types';
import { RadarIcon, ChevronRightIcon, CheckIcon } from '../../components/icons';
import Link from 'next/link';

interface FeedData {
  items: PersonalizedFeedItem[];
  meta: {
    total: number;
    limit: number;
    offset: number;
    user_has_follows: boolean;
    fallback_applied: boolean;
    acknowledged_through?: number;
    unread_event_count?: number;
    updated_event_count?: number;
    all_caught_up?: boolean;
  };
}

export default function ForYouPage() {
  const [feedData, setFeedData] = useState<FeedData | null>(null);
  const [catchUpItems, setCatchUpItems] = useState<PersonalizedFeedItem[] | null>(null);
  const [activeTab, setActiveTab] = useState<'feed' | 'catch-up'>('feed');
  const [loading, setLoading] = useState(true);
  const [markingCaughtUp, setMarkingCaughtUp] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFeed = useCallback(async () => {
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
    }
  }, []);

  const loadCatchUp = useCallback(async () => {
    try {
      const res = await fetch('/api/feed/since-last-seen?limit=20');
      if (res.ok) {
        const json = await res.json();
        if (json.success && json.data) {
          setCatchUpItems(json.data.items);
        }
      }
    } catch (err) {
      console.error('Error fetching /api/feed/since-last-seen:', err);
    }
  }, []);

  useEffect(() => {
    const init = async () => {
      setLoading(true);
      await Promise.all([loadFeed(), loadCatchUp()]);
      setLoading(false);
    };
    init();
  }, [loadFeed, loadCatchUp]);

  const handleMarkCaughtUp = async () => {
    setMarkingCaughtUp(true);
    try {
      const res = await fetch('/api/feed/ack-seen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        await Promise.all([loadFeed(), loadCatchUp()]);
      }
    } catch (err) {
      console.error('Error marking feed caught up:', err);
    } finally {
      setMarkingCaughtUp(false);
    }
  };

  const handleMarkRead = async (eventHash: string, eventId?: number) => {
    try {
      await fetch('/api/feed/read-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_hash: eventHash, event_id: eventId }),
      });
      // Refresh local state without full reload
      await Promise.all([loadFeed(), loadCatchUp()]);
    } catch (err) {
      console.error('Error marking event read:', err);
    }
  };

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
            onClick={() => {
              setLoading(true);
              Promise.all([loadFeed(), loadCatchUp()]).finally(() => setLoading(false));
            }}
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
  const unreadCount = meta.unread_event_count ?? 0;
  const updatedCount = meta.updated_event_count ?? 0;
  const totalChanged = unreadCount + updatedCount;
  const allCaughtUp = meta.all_caught_up ?? totalChanged === 0;

  const displayItems = activeTab === 'catch-up' ? (catchUpItems ?? []) : items;

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

      {/* Phase 11C: Catch-Up Intelligence Banner */}
      {!allCaughtUp && totalChanged > 0 ? (
        <div className="bg-gradient-to-r from-indigo-50 to-purple-50 dark:from-indigo-950/40 dark:to-purple-950/30 border border-indigo-200 dark:border-indigo-800/60 rounded-xl p-5 shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-start sm:items-center gap-3">
              <div className="p-2 rounded-lg bg-indigo-600 text-white shadow-sm mt-0.5 sm:mt-0">
                <RadarIcon className="w-5 h-5 animate-pulse" />
              </div>
              <div>
                <h4 className="text-sm font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
                  <span>Since Your Last Visit</span>
                  <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200 font-mono">
                    {totalChanged} updates
                  </span>
                </h4>
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">
                  {unreadCount > 0 && (
                    <span className="font-semibold text-emerald-700 dark:text-emerald-400 mr-2">
                      ✨ {unreadCount} new event{unreadCount > 1 ? 's' : ''}
                    </span>
                  )}
                  {updatedCount > 0 && (
                    <span className="font-semibold text-indigo-700 dark:text-indigo-400">
                      🔄 {updatedCount} updated event{updatedCount > 1 ? 's' : ''}
                    </span>
                  )}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
              {catchUpItems && catchUpItems.length > 0 && (
                <button
                  type="button"
                  onClick={() => setActiveTab(activeTab === 'catch-up' ? 'feed' : 'catch-up')}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
                    activeTab === 'catch-up'
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700'
                  }`}
                >
                  {activeTab === 'catch-up' ? 'Show All Feed' : `Catch-Up Stream (${catchUpItems.length})`}
                </button>
              )}

              <button
                type="button"
                onClick={handleMarkCaughtUp}
                disabled={markingCaughtUp}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white transition-colors shadow-sm disabled:opacity-50"
              >
                <CheckIcon className="w-3.5 h-3.5" />
                {markingCaughtUp ? 'Marking...' : 'Mark Caught Up'}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="bg-emerald-50/70 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-800/40 rounded-xl p-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="w-6 h-6 rounded-full bg-emerald-100 dark:bg-emerald-900/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center text-xs font-bold">
              ✓
            </div>
            <p className="text-xs font-medium text-emerald-900 dark:text-emerald-300">
              <span className="font-semibold">All caught up!</span> You are up to date on all recent developments and event evolutions.
            </p>
          </div>
          {activeTab === 'catch-up' && (
            <button
              type="button"
              onClick={() => setActiveTab('feed')}
              className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 hover:underline whitespace-nowrap"
            >
              Back to Full Feed &rarr;
            </button>
          )}
        </div>
      )}

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
      {displayItems.length > 0 && (
        <section aria-label="Personalized events" className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="flex h-2 w-2 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-600 dark:bg-indigo-400"></span>
              </span>
              <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
                <RadarIcon className="w-4 h-4 text-indigo-500" />
                {activeTab === 'catch-up'
                  ? 'Catch-Up Stream (Since Last Seen)'
                  : hasFollows && !isFallback
                    ? 'Events Matching Your Profile'
                    : 'Top Event Intelligence'}
              </h3>
              <span className="text-xs font-bold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-500/10 px-2 py-0.5 rounded-full border border-indigo-200 dark:border-indigo-500/20 font-mono">
                {displayItems.length}
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
            {displayItems.map(item => (
              <EventCard
                key={item.hash || `ev-${item.id}`}
                event={item}
                rankReasons={item.rank_reasons}
                briefVersion={item.brief_version}
                score={item.score}
                sinceLastSeen={item.since_last_seen}
                onMarkRead={handleMarkRead}
              />
            ))}
          </div>
        </section>
      )}

      {/* Personalized Articles Feed */}
      {activeTab === 'feed' && (
        <section aria-label="Personalized article stream" className="space-y-4 pt-4">
          <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">
            Latest Article Stream
          </h3>
          <Feed />
        </section>
      )}
    </div>
  );
}
