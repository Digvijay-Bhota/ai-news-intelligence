'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { EventCard } from '../../components/EventCard';
import type { PersonalizedFeedItem } from '../../types';
import { SectionLabel, Divider } from '../../components/Foundations';
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
      const [feedRes, slsRes] = await Promise.all([
        fetch('/api/feed/for-you?limit=20'),
        fetch('/api/feed/since-last-seen?limit=20'),
      ]);
      if (!feedRes.ok) throw new Error(`Feed error (${feedRes.status})`);
      const feedJson = await feedRes.json();
      setFeedData(feedJson.data);
      if (slsRes.ok) {
        const slsJson = await slsRes.json();
        const items: PersonalizedFeedItem[] = slsJson.data?.items ?? [];
        setCatchUpItems(items.length > 0 ? items : null);
        if (items.length > 0) setActiveTab('catch-up');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load feed.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadFeed(); }, [loadFeed]);

  const handleMarkRead = useCallback(async (_eventHash: string, eventId?: number) => {
    if (!eventId) return;
    try {
      await fetch('/api/feed/read-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_id: eventId }),
      });
    } catch { /* silent */ }
  }, []);

  const handleMarkCaughtUp = async () => {
    setMarkingCaughtUp(true);
    try {
      await fetch('/api/feed/ack-seen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      setCatchUpItems(null);
      setActiveTab('feed');
      setFeedData(prev => prev ? { ...prev, meta: { ...prev.meta, all_caught_up: true, unread_event_count: 0, updated_event_count: 0 } } : prev);
    } finally {
      setMarkingCaughtUp(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto py-8">
        <div className="animate-pulse space-y-8">
          <div className="h-4 bg-divider rounded w-32" />
          <div className="h-10 bg-divider rounded w-2/3" />
          <div className="h-4 bg-divider rounded w-full" />
          <div className="h-4 bg-divider rounded w-5/6" />
          <Divider className="my-8" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {[1,2,3,4].map(i => <div key={i} className="h-36 bg-divider rounded" />)}
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-6xl mx-auto py-8">
        <p className="font-sans text-sm text-breaking">{error}</p>
      </div>
    );
  }

  const items = feedData?.items ?? [];
  const meta = feedData?.meta;
  const hasFollows = meta?.user_has_follows ?? false;
  const isFallback = meta?.fallback_applied ?? false;
  const unreadCount = meta?.unread_event_count ?? 0;
  const updatedCount = meta?.updated_event_count ?? 0;
  const allCaughtUp = meta?.all_caught_up ?? true;
  const totalChanged = unreadCount + updatedCount;

  const displayItems = activeTab === 'catch-up' && catchUpItems ? catchUpItems : items;
  const [lead, ...rest] = displayItems;

  return (
    <div className="max-w-6xl mx-auto">

      {/* ── Since-Last-Seen Banner ───────────────────────────────── */}
      {!allCaughtUp && totalChanged > 0 && (
        <div className="mb-10 border-l-4 border-accent bg-accent/5 dark:bg-accent/10 p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="font-sans text-[11px] font-bold tracking-widest uppercase text-accent mb-1">
              Since Your Last Visit
            </div>
            <p className="font-sans text-sm text-charcoal">
              {unreadCount > 0 && <span className="font-bold">{unreadCount} new {unreadCount === 1 ? 'story' : 'stories'}</span>}
              {unreadCount > 0 && updatedCount > 0 && ' and '}
              {updatedCount > 0 && <span className="font-bold">{updatedCount} updated {updatedCount === 1 ? 'story' : 'stories'}</span>}
              {' since you were last here.'}
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {catchUpItems && catchUpItems.length > 0 && (
              <button
                type="button"
                onClick={() => setActiveTab(activeTab === 'catch-up' ? 'feed' : 'catch-up')}
                className="font-sans text-xs font-bold text-accent border border-accent px-3 py-1.5 hover:bg-accent/10 transition-colors"
              >
                {activeTab === 'catch-up' ? 'Full Feed' : `View ${catchUpItems.length} Updates`}
              </button>
            )}
            <button
              type="button"
              onClick={handleMarkCaughtUp}
              disabled={markingCaughtUp}
              className="font-sans text-xs font-bold text-white bg-accent px-3 py-1.5 hover:bg-accent/90 transition-colors disabled:opacity-50"
            >
              {markingCaughtUp ? 'Marking…' : 'Mark Caught Up'}
            </button>
          </div>
        </div>
      )}

      {allCaughtUp && (
        <div className="mb-8 flex items-center gap-3 border-l-4 border-positive p-4 bg-positive/5">
          <div className="w-5 h-5 rounded-full border-2 border-positive flex items-center justify-center text-xs text-positive font-bold">✓</div>
          <p className="font-sans text-sm text-charcoal">
            <span className="font-bold">All caught up.</span> You are up to date with all recent developments.
          </p>
        </div>
      )}

      {/* ── No-follows cold-start prompt ─────────────────────────── */}
      {!hasFollows && (
        <div className="mb-10 p-5 border border-divider bg-surface flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="font-sans text-[11px] font-bold tracking-widest uppercase text-accent mb-1">
              Personalize Your Feed
            </div>
            <p className="font-sans text-sm text-charcoal">
              Follow topics, sources, or events to surface what matters to you.
            </p>
          </div>
          <Link
            href="/topics"
            className="font-sans text-xs font-bold text-white bg-charcoal px-4 py-2 hover:bg-ink transition-colors shrink-0"
          >
            Explore Topics →
          </Link>
        </div>
      )}

      {/* ── Fallback notice ──────────────────────────────────────── */}
      {hasFollows && isFallback && (
        <div className="mb-8 p-4 border-l-4 border-developing bg-developing/5">
          <p className="font-sans text-sm text-charcoal">
            <span className="font-bold">No activity in your followed topics today.</span>{' '}
            Showing top active intelligence instead.{' '}
            <Link href="/settings" className="underline text-accent">Manage follows →</Link>
          </p>
        </div>
      )}

      {/* ── Section label ────────────────────────────────────────── */}
      <div className="mb-8">
        <SectionLabel>
          {activeTab === 'catch-up'
            ? 'Changed Since Your Last Visit'
            : hasFollows && !isFallback
              ? 'Your Intelligence Briefing'
              : 'Top Event Intelligence'}
        </SectionLabel>
      </div>

      {displayItems.length === 0 ? (
        <p className="font-sans text-sm text-slate italic">No events to display.</p>
      ) : (
        <>
          {/* ── Desktop: Lead + Sidebar layout ───────────────────── */}
          <div className="hidden lg:grid lg:grid-cols-3 lg:gap-10 mb-12">
            {/* Lead story takes 2/3 */}
            {lead && (
              <div className="col-span-2">
                <EventCard
                  key={lead.hash || `ev-${lead.id}`}
                  event={lead}
                  rankReasons={lead.rank_reasons}
                  briefVersion={lead.brief_version}
                  score={lead.score}
                  sinceLastSeen={lead.since_last_seen}
                  onMarkRead={handleMarkRead}
                  lead
                />
              </div>
            )}

            {/* Latest sidebar — 1/3 */}
            {rest.length > 0 && (
              <div className="col-span-1 flex flex-col border-l border-divider pl-6">
                <div className="font-sans text-[11px] font-bold tracking-widest uppercase text-slate mb-4">
                  Latest Developments
                </div>
                <div className="flex flex-col divide-y divide-divider">
                  {rest.slice(0, 5).map(item => (
                    <div key={item.hash || `ev-${item.id}`} className="py-3 first:pt-0">
                      <EventCard
                        event={item}
                        rankReasons={item.rank_reasons}
                        briefVersion={item.brief_version}
                        score={item.score}
                        sinceLastSeen={item.since_last_seen}
                        onMarkRead={handleMarkRead}
                        compact
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Grid for remaining stories (desktop) */}
          {rest.length > 5 && (
            <div className="hidden lg:block">
              <Divider className="mb-8" />
              <div className="font-sans text-[11px] font-bold tracking-widest uppercase text-slate mb-6">
                More Intelligence
              </div>
              <div className="grid grid-cols-2 xl:grid-cols-3 gap-6">
                {rest.slice(5).map(item => (
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
            </div>
          )}

          {/* ── Mobile/Tablet: Single column list ────────────────── */}
          <div className="lg:hidden flex flex-col divide-y divide-divider">
            {lead && (
              <div className="pb-6">
                <EventCard
                  key={lead.hash || `ev-${lead.id}`}
                  event={lead}
                  rankReasons={lead.rank_reasons}
                  briefVersion={lead.brief_version}
                  score={lead.score}
                  sinceLastSeen={lead.since_last_seen}
                  onMarkRead={handleMarkRead}
                  lead
                />
              </div>
            )}
            {rest.map(item => (
              <div key={item.hash || `ev-${item.id}`} className="py-6">
                <EventCard
                  event={item}
                  rankReasons={item.rank_reasons}
                  briefVersion={item.brief_version}
                  score={item.score}
                  sinceLastSeen={item.since_last_seen}
                  onMarkRead={handleMarkRead}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
