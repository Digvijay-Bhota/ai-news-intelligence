'use client';

import React from 'react';
import Link from 'next/link';
import type { EventSummary, SinceLastSeenInfo } from '../types';
import { formatRelativeTime } from '../lib/utils';
import { ClockIcon, ChevronRightIcon, ActivityIcon } from './icons';
import { FollowButton } from './FollowButton';

interface EventCardProps {
  event: EventSummary;
  matchedReason?: string | null;
  rankReasons?: string[];
  briefVersion?: number;
  score?: number;
  compact?: boolean;
  sinceLastSeen?: SinceLastSeenInfo;
  onMarkRead?: (eventHash: string, eventId?: number) => void;
}

export function EventCard({
  event,
  matchedReason,
  rankReasons,
  briefVersion,
  score,
  compact = false,
  sinceLastSeen,
  onMarkRead,
}: EventCardProps) {
  const isDeveloping = event.freshness === 'developing';
  const isStale = event.freshness === 'stale';
  const activeReasons = rankReasons || event.rank_reasons || (matchedReason ? [matchedReason] : []);
  const effectiveBriefVersion = briefVersion ?? event.brief_version ?? 0;
  const delta = sinceLastSeen || (event as any).since_last_seen as SinceLastSeenInfo | undefined;

  const severityClasses = {
    critical: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-500/10 dark:text-red-400 dark:border-red-500/20',
    high: 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/20',
    warning: 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/20',
    medium: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-500/10 dark:text-blue-400 dark:border-blue-500/20',
    low: 'bg-gray-100 text-gray-700 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700',
    info: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
  }[event.severity] || 'bg-gray-100 text-gray-700 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700';

  const borderAccent = isDeveloping
    ? 'border-l-4 border-l-emerald-500'
    : event.severity === 'critical'
      ? 'border-l-4 border-l-red-500'
      : event.severity === 'high' || event.severity === 'warning'
        ? 'border-l-4 border-l-amber-500'
        : 'border-l-4 border-l-indigo-500';

  return (
    <article className={`group relative bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-sm hover:shadow-md hover:border-indigo-300 dark:hover:border-indigo-500/40 transition-all duration-200 flex flex-col ${borderAccent} ${compact ? 'p-4' : 'p-6'}`}>
      {/* Top badges & telemetry */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          {/* Since-Last-Seen Delta Badge (Phase 11C) */}
          {delta && delta.change_type === 'NEW_EVENT' && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-emerald-600 text-white shadow-sm tracking-wide">
              ✨ NEW
            </span>
          )}
          {delta && delta.change_type === 'NARRATIVE_EVOLVED' && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-600 text-white shadow-sm">
              🔄 Evolved
            </span>
          )}
          {delta && delta.change_type === 'CROSS_SOURCE_PERSPECTIVE' && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-cyan-700 text-white shadow-sm">
              ⚖️ Perspectives
            </span>
          )}
          {delta && delta.change_type === 'NEW_REPORTING' && delta.new_article_count > 0 && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-600 text-white shadow-sm">
              +{delta.new_article_count} new report{delta.new_article_count > 1 ? 's' : ''}
            </span>
          )}

          {/* Freshness Badge */}
          {isDeveloping ? (
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/20">
              <span className="relative flex h-2 w-2 mr-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              Developing
            </span>
          ) : isStale ? (
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400 border border-gray-200 dark:border-gray-700">
              <span className="h-1.5 w-1.5 rounded-full bg-gray-400 mr-1.5"></span>
              Concluded
            </span>
          ) : (
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-500/10 dark:text-blue-400 border border-blue-200 dark:border-blue-500/20">
              <span className="h-1.5 w-1.5 rounded-full bg-blue-500 mr-1.5"></span>
              Active
            </span>
          )}

          {/* Severity Badge */}
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wider border ${severityClasses}`}>
            {event.severity}
          </span>

          {/* Brief Version Badge (when >= 2 and not in reasons) */}
          {effectiveBriefVersion >= 2 && !activeReasons.some(r => r.startsWith('Narrative Evolved')) && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 border border-amber-200 dark:border-amber-800/40">
              🔄 V{effectiveBriefVersion} Brief
            </span>
          )}

          {/* Rank Reasons Badges */}
          {activeReasons.map(reason => {
            const isFollow = reason.startsWith('Following') || reason.startsWith('Topic') || reason.startsWith('Source');
            const isEvolved = reason.startsWith('Narrative Evolved');
            const isPerspective = reason.startsWith('Cross-Source');
            const badgeClass = isFollow
              ? 'bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 border-purple-200 dark:border-purple-800/40'
              : isEvolved
                ? 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 border-amber-200 dark:border-amber-800/40'
                : isPerspective
                  ? 'bg-cyan-50 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300 border-cyan-200 dark:border-cyan-800/40'
                  : 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800/40';

            return (
              <span
                key={reason}
                className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${badgeClass}`}
              >
                {isFollow ? '⭐ ' : isEvolved ? '🔄 ' : isPerspective ? '⚖️ ' : ''}{reason}
              </span>
            );
          })}
        </div>

        {/* Latest Activity Timestamp & Follow Action */}
        <div className="flex items-center gap-2">
          {event.last_published_at && (
            <div className="flex items-center text-xs text-gray-500 dark:text-gray-400 font-mono">
              <ClockIcon className="w-3.5 h-3.5 mr-1 text-gray-400" />
              <span>{formatRelativeTime(event.last_published_at)}</span>
            </div>
          )}
          <FollowButton targetType="event" targetId={event.hash} compact />
        </div>
      </div>

      {/* Event Title */}
      <h3 className={`font-bold text-gray-900 dark:text-gray-100 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors leading-snug ${compact ? 'text-base mb-2' : 'text-xl mb-2.5'}`}>
        <Link
          href={`/events/${event.hash}`}
          onClick={() => onMarkRead?.(event.hash, (event as any).id)}
          className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded"
        >
          {event.title}
        </Link>
      </h3>

      {/* Event Description */}
      {event.description && (
        <p className={`text-gray-600 dark:text-gray-300 leading-relaxed mb-4 flex-1 ${compact ? 'text-xs line-clamp-2' : 'text-sm line-clamp-3'}`}>
          {event.description}
        </p>
      )}

      {/* Bottom Intelligence Metrics Footer */}
      <div className="pt-3 border-t border-gray-100 dark:border-gray-800/80 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 font-mono">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="inline-flex items-center font-semibold text-gray-700 dark:text-gray-300">
            <ActivityIcon className="w-3.5 h-3.5 mr-1 text-indigo-500" />
            {event.article_count} {event.article_count === 1 ? 'article' : 'articles'}
          </span>

          {event.source_count !== undefined && event.source_count > 0 && (
            <span className="text-gray-500 dark:text-gray-400">
              · {event.source_count} {event.source_count === 1 ? 'source' : 'sources'}
            </span>
          )}

          {event.article_count > 1 && (
            <span className="hidden sm:inline text-emerald-600 dark:text-emerald-400 font-medium">
              · Corroborated
            </span>
          )}
        </div>

        <Link
          href={`/events/${event.hash}`}
          onClick={() => onMarkRead?.(event.hash, (event as any).id)}
          className="inline-flex items-center text-xs font-semibold text-indigo-600 dark:text-indigo-400 group-hover:translate-x-1 transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded"
          tabIndex={-1}
          aria-hidden="true"
        >
          Story Hub
          <ChevronRightIcon className="w-4 h-4 ml-0.5" />
        </Link>
      </div>
    </article>
  );
}
