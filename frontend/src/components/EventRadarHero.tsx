'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { fetchActiveEvents } from '../lib/api';
import type { EventSummary, GlobalFreshnessSummary } from '../types';
import { EventCard } from './EventCard';
import { SectionLabel, Metadata, Divider } from './Foundations';

export function EventRadarHero() {
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [summary, setSummary] = useState<GlobalFreshnessSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetchActiveEvents({ sort: 'priority' });
        if (res.success && res.data) {
          setEvents(res.data.items.slice(0, 5));
          setSummary(res.data.summary);
        }
      } catch {
        // silent
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <section aria-label="Loading event radar" className="mb-12 animate-pulse space-y-4">
        <div className="h-3 bg-divider rounded w-32" />
        <div className="h-8 bg-divider rounded w-1/2" />
        <Divider className="my-6" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1,2,3].map(i => <div key={i} className="h-40 bg-divider rounded" />)}
        </div>
      </section>
    );
  }

  if (events.length === 0) return null;

  const [lead, ...rest] = events;

  return (
    <section aria-label="Event Intelligence Radar" className="mb-12">
      {/* Section header */}
      <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-2 mb-6">
        <SectionLabel className="mb-0">Active Event Intelligence</SectionLabel>
        {summary && (
          <Metadata>
            <span><span className="font-bold text-developing">{summary.developing}</span> Developing</span>
            <span className="text-divider">·</span>
            <span><span className="font-bold">{summary.active}</span> Active</span>
            <span className="text-divider">·</span>
            <span><span className="font-bold">{summary.total}</span> Total</span>
          </Metadata>
        )}
      </div>

      {/* Desktop: Lead + right column */}
      <div className="hidden lg:grid lg:grid-cols-3 gap-10 mb-8">
        {lead && (
          <div className="col-span-2">
            <EventCard event={lead} lead />
          </div>
        )}
        {rest.length > 0 && (
          <div className="col-span-1 flex flex-col border-l border-divider pl-6 divide-y divide-divider">
            {rest.slice(0, 4).map(event => (
              <div key={event.hash} className="py-3 first:pt-0">
                <EventCard event={event} compact />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Mobile/Tablet: stacked cards */}
      <div className="lg:hidden grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        {events.map(event => (
          <EventCard key={event.hash} event={event} />
        ))}
      </div>

      <Divider />
      <div className="pt-3 flex justify-end">
        <Link
          href="/events"
          className="font-sans text-xs font-bold text-slate hover:text-charcoal uppercase tracking-widest transition-colors"
        >
          View all {summary?.total ?? ''} events →
        </Link>
      </div>
    </section>
  );
}
