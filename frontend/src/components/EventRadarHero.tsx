'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { fetchActiveEvents } from '../lib/api';
import type { EventSummary, GlobalFreshnessSummary } from '../types';
import { EventCard } from './EventCard';
import { RadarIcon, ChevronRightIcon } from './icons';

export function EventRadarHero() {
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [summary, setSummary] = useState<GlobalFreshnessSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetchActiveEvents({ sort: 'priority' });
        if (res.success && res.data) {
          setEvents(res.data.items.slice(0, 3));
          setSummary(res.data.summary);
        }
      } catch (err) {
        console.error('Failed to load event radar:', err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="mb-10 p-6 rounded-2xl bg-gradient-to-br from-indigo-900/5 via-purple-900/5 to-transparent border border-indigo-100 dark:border-indigo-900/30">
        <div className="h-6 w-48 bg-gray-200 dark:bg-gray-800 rounded animate-pulse mb-4" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="h-48 bg-gray-100 dark:bg-gray-800/60 rounded-xl animate-pulse" />
          <div className="h-48 bg-gray-100 dark:bg-gray-800/60 rounded-xl animate-pulse" />
          <div className="h-48 bg-gray-100 dark:bg-gray-800/60 rounded-xl animate-pulse" />
        </div>
      </div>
    );
  }

  if (events.length === 0) return null;

  return (
    <section aria-label="Event Intelligence Radar" className="mb-10 p-6 rounded-2xl bg-gradient-to-br from-indigo-50/70 via-purple-50/40 to-white dark:from-indigo-950/30 dark:via-purple-950/20 dark:to-gray-900 border border-indigo-100/80 dark:border-indigo-900/40 shadow-sm">
      {/* Top telemetry banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="flex h-2 w-2 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-600 dark:bg-indigo-400"></span>
            </span>
            <span className="text-xs font-bold uppercase tracking-wider text-indigo-700 dark:text-indigo-400 font-mono flex items-center gap-1.5">
              <RadarIcon className="w-3.5 h-3.5" />
              Live Event Radar
            </span>
            <span className="text-xs text-gray-400 dark:text-gray-500 font-mono">
              Semantic Clustering Active
            </span>
          </div>
          <h2 className="text-2xl font-black text-gray-900 dark:text-gray-100 tracking-tight">
            Unfolding Story Clusters
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5">
            Articles automatically synthesized into coherent, evolving intelligence events.
          </p>
        </div>

        {/* Global Telemetry HUD */}
        {summary && (
          <div className="flex items-center gap-3 text-xs font-mono bg-white/80 dark:bg-gray-850/80 backdrop-blur px-3.5 py-2 rounded-xl border border-gray-200/80 dark:border-gray-800 shadow-xs self-start sm:self-auto">
            <div>
              <span className="text-gray-500 dark:text-gray-400">Total:</span>{' '}
              <span className="font-bold text-gray-900 dark:text-gray-100">{summary.total}</span>
            </div>
            <span className="text-gray-300 dark:text-gray-700">|</span>
            <div>
              <span className="text-emerald-600 dark:text-emerald-400">Developing:</span>{' '}
              <span className="font-bold text-emerald-700 dark:text-emerald-300">{summary.developing}</span>
            </div>
            <span className="text-gray-300 dark:text-gray-700">|</span>
            <div>
              <span className="text-indigo-600 dark:text-indigo-400">Active:</span>{' '}
              <span className="font-bold text-indigo-700 dark:text-indigo-300">{summary.active}</span>
            </div>
          </div>
        )}
      </div>

      {/* Featured Event Clusters Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-5">
        {events.map((event) => (
          <EventCard key={event.hash} event={event} compact />
        ))}
      </div>

      {/* Footer link to full dashboard */}
      <div className="flex items-center justify-between pt-3 border-t border-indigo-100/60 dark:border-indigo-900/40 text-xs">
        <span className="text-gray-500 dark:text-gray-400 font-mono">
          Showing top 3 prioritized stories based on coverage velocity and severity
        </span>
        <Link
          href="/events"
          className="font-bold text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300 inline-flex items-center group transition-colors"
        >
          View all {summary?.total ?? ''} events on Intelligence Dashboard
          <ChevronRightIcon className="w-4 h-4 ml-1 group-hover:translate-x-1 transition-transform" />
        </Link>
      </div>
    </section>
  );
}
