'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { Feed } from '../../components/Feed';
import { EventCard } from '../../components/EventCard';
import { fetchActiveEvents } from '../../lib/api';
import type { EventSummary } from '../../types';
import { RadarIcon, ChevronRightIcon } from '../../components/icons';
import Link from 'next/link';

export default function ForYouPage() {
  const [prefTopics, setPrefTopics] = useState<string[]>([]);
  const [prefSources, setPrefSources] = useState<string[]>([]);
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const [prefRes, eventsRes] = await Promise.all([
          fetch('/api/preferences'),
          fetchActiveEvents().catch(() => ({ success: false, data: { items: [], summary: { total: 0, developing: 0, active: 0, stale: 0 } } }))
        ]);

        if (!prefRes.ok) throw new Error('Failed to load preferences');
        const prefJson = await prefRes.json();
        if (prefJson.success && prefJson.data) {
          setPrefTopics(prefJson.data.preferred_topics || []);
          setPrefSources(prefJson.data.preferred_sources || []);
        }

        if (eventsRes.success && eventsRes.data?.items) {
          setEvents(eventsRes.data.items);
        }
      } catch (err) {
        console.error(err);
        setError(true);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const hasPreferences = prefTopics.length > 0 || prefSources.length > 0;

  // Compute events matching the user's preferred topics or sources
  const matchedEvents = useMemo(() => {
    if (!hasPreferences || events.length === 0) return [];

    const matches: { event: EventSummary; reason: string }[] = [];

    for (const ev of events) {
      const text = `${ev.title} ${ev.description || ''}`.toLowerCase();
      let matchedReason: string | null = null;

      for (const topic of prefTopics) {
        if (text.includes(topic.toLowerCase())) {
          matchedReason = `Matched via topic: ${topic}`;
          break;
        }
      }

      if (matchedReason) {
        matches.push({ event: ev, reason: matchedReason });
      }
    }

    return matches;
  }, [events, prefTopics, hasPreferences]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="mb-8">
          <h2 className="text-3xl font-bold text-gray-900 dark:text-gray-100 tracking-tight">For You</h2>
          <p className="mt-2 text-lg text-gray-600 dark:text-gray-400">Loading your personalized intelligence briefing...</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="h-44 bg-gray-100 dark:bg-gray-800 rounded-xl animate-pulse"></div>
          <div className="h-44 bg-gray-100 dark:bg-gray-800 rounded-xl animate-pulse"></div>
        </div>
        <div className="h-64 bg-gray-100 dark:bg-gray-800 rounded-xl animate-pulse mt-6"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-3xl py-12 text-center">
        <p className="text-red-500">Failed to load personalized feed.</p>
        <Link href="/" className="mt-4 inline-block text-indigo-600 hover:text-indigo-800 text-sm">
          Return to Feed
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-3xl font-bold text-gray-900 dark:text-gray-100 tracking-tight">For You</h2>
          <p className="mt-1 text-base text-gray-600 dark:text-gray-400">
            Curated intelligence stream matching your topics and sources.
          </p>
        </div>
        <Link
          href="/settings"
          className="inline-flex items-center text-xs font-semibold text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300"
        >
          Manage Preferences &rarr;
        </Link>
      </div>

      {!hasPreferences ? (
        <div className="bg-white dark:bg-gray-900 p-12 rounded-xl shadow-sm border border-gray-200 dark:border-gray-800 text-center">
          <div className="w-12 h-12 rounded-full bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 flex items-center justify-center mx-auto mb-4">
            <RadarIcon className="w-6 h-6" />
          </div>
          <h3 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">No Preferences Configured</h3>
          <p className="text-gray-600 dark:text-gray-400 mb-6 max-w-md mx-auto">
            You haven&apos;t selected any preferred topics or sources yet. Customize your settings to get personalized event intelligence and article alerts.
          </p>
          <Link
            href="/settings"
            className="inline-flex items-center justify-center px-5 py-2.5 border border-transparent text-sm font-semibold rounded-lg text-white bg-indigo-600 hover:bg-indigo-700 transition-colors shadow-sm"
          >
            Configure Preferences
          </Link>
        </div>
      ) : (
        <>
          {/* Events Matching Your Profile Section */}
          {matchedEvents.length > 0 && (
            <section aria-label="Events matching your profile" className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="flex h-2 w-2 relative">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-600 dark:bg-indigo-400"></span>
                  </span>
                  <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
                    <RadarIcon className="w-4 h-4 text-indigo-500" />
                    Events Matching Your Profile
                  </h3>
                  <span className="text-xs font-bold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-500/10 px-2 py-0.5 rounded-full border border-indigo-200 dark:border-indigo-500/20 font-mono">
                    {matchedEvents.length}
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
                {matchedEvents.map(({ event, reason }) => (
                  <EventCard
                    key={evHashOrFallback(event.hash)}
                    event={event}
                    matchedReason={reason}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Personalized Articles Feed */}
          <section aria-label="Personalized article feed" className="space-y-4 pt-2">
            <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">
              Personalized Article Stream
            </h3>
            <Feed topicsOverride={prefTopics} sourceNamesOverride={prefSources} />
          </section>
        </>
      )}
    </div>
  );
}

function evHashOrFallback(hash: string): string {
  return hash || `ev-${Math.random().toString(36).substring(2, 7)}`;
}
