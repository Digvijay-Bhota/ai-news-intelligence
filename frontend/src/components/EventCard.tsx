'use client';

import React from 'react';
import Link from 'next/link';
import type { EventSummary, SinceLastSeenInfo } from '../types';
import { formatRelativeTime } from '../lib/utils';
import { FollowButton } from './FollowButton';
import { Kicker, Metadata } from './Foundations';
import { SourceChip } from './Editorial/SourceChip';

interface EventCardProps {
  event: EventSummary;
  matchedReason?: string | null;
  rankReasons?: string[];
  briefVersion?: number;
  score?: number;
  compact?: boolean;
  sinceLastSeen?: SinceLastSeenInfo;
  onMarkRead?: (eventHash: string, eventId?: number) => void;
  /** Render as the lead story (large, prominent) */
  lead?: boolean;
}

function kickerFromContext(
  delta: SinceLastSeenInfo | undefined,
  freshness: string,
  severity: string,
  rankReasons: string[],
  briefVersion: number,
): { text: string; type: 'developing' | 'breaking' | 'positive' | 'accent' | 'default' } {
  // Since-last-seen takes first priority
  if (delta?.change_type === 'NEW_EVENT') return { text: 'New Story', type: 'positive' };
  if (delta?.change_type === 'NARRATIVE_EVOLVED') return { text: 'Story Evolved', type: 'developing' };
  if (delta?.change_type === 'CROSS_SOURCE_PERSPECTIVE') return { text: 'New Perspectives', type: 'accent' };
  if (delta?.change_type === 'NEW_REPORTING' && (delta?.new_article_count ?? 0) > 0) return { text: `+${delta?.new_article_count} New Reports`, type: 'accent' };

  // Severity
  if (severity === 'critical') return { text: 'Critical Update', type: 'breaking' };

  // Freshness
  if (freshness === 'developing') return { text: 'Developing Story', type: 'developing' };

  // Follow context
  const followReason = rankReasons.find(r => r.startsWith('Following') || r.startsWith('Topic') || r.startsWith('Source'));
  if (followReason) return { text: 'Because You Follow', type: 'accent' };

  // Intelligence enrichment
  const evolved = rankReasons.find(r => r.startsWith('Narrative Evolved'));
  if (evolved || briefVersion >= 2) return { text: 'Intelligence Updated', type: 'developing' };

  const crossSource = rankReasons.find(r => r.startsWith('Cross-Source'));
  if (crossSource) return { text: 'Multi-Source Analysis', type: 'accent' };

  return { text: 'Active Intelligence', type: 'default' };
}

export function EventCard({
  event,
  matchedReason,
  rankReasons,
  briefVersion,
  compact = false,
  sinceLastSeen,
  onMarkRead,
  lead = false,
}: EventCardProps) {
  const isDeveloping = event.freshness === 'developing';
  const isStale = event.freshness === 'stale';
  const activeReasons = rankReasons || event.rank_reasons || (matchedReason ? [matchedReason] : []);
  const effectiveBriefVersion = briefVersion ?? event.brief_version ?? 0;
  const delta = sinceLastSeen || (event as any).since_last_seen as SinceLastSeenInfo | undefined;

  const kicker = kickerFromContext(delta, event.freshness, event.severity, activeReasons, effectiveBriefVersion);

  // Left accent bar color based on state
  const accentColor = isDeveloping
    ? 'border-l-developing'
    : event.severity === 'critical'
      ? 'border-l-breaking'
      : delta?.change_type
        ? 'border-l-accent'
        : 'border-l-divider';

  if (lead) {
    return (
      <article className={`group flex flex-col border-l-4 ${accentColor} pl-6 pb-6`}>
        <Kicker type={kicker.type}>{kicker.text}</Kicker>
        <h2 className="font-serif font-bold text-ink leading-tight text-3xl sm:text-4xl mb-4 group-hover:text-accent transition-colors">
          <Link
            href={`/events/${event.hash}`}
            onClick={() => onMarkRead?.(event.hash, (event as any).id)}
            className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
          >
            {event.title}
          </Link>
        </h2>
        {event.description && (
          <p className="font-serif text-charcoal/80 leading-relaxed text-base mb-4 line-clamp-4 flex-1">
            {event.description}
          </p>
        )}
        <div className="flex items-center justify-between mt-auto pt-4 border-t border-divider">
          <Metadata>
            {event.sources && event.sources.length > 0 && (
              <SourceChip name={event.sources[0]} />
            )}
            {(event.source_count ?? 0) > 1 && (
              <span className="text-slate text-xs">+{(event.source_count ?? 0) - 1} more</span>
            )}
            <span className="text-divider">·</span>
            <span>{event.article_count} {event.article_count === 1 ? 'article' : 'articles'}</span>
            {event.last_published_at && (
              <>
                <span className="text-divider">·</span>
                <span>{formatRelativeTime(event.last_published_at)}</span>
              </>
            )}
          </Metadata>
          <FollowButton targetType="event" targetId={event.hash} compact />
        </div>
      </article>
    );
  }

  if (compact) {
    return (
      <article className={`group flex flex-col gap-1 border-l-2 ${accentColor} pl-4 py-3`}>
        <Kicker type={kicker.type}>{kicker.text}</Kicker>
        <h3 className="font-sans font-bold text-charcoal leading-snug text-sm group-hover:text-accent transition-colors line-clamp-2">
          <Link
            href={`/events/${event.hash}`}
            onClick={() => onMarkRead?.(event.hash, (event as any).id)}
            className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
          >
            {event.title}
          </Link>
        </h3>
        <Metadata>
          {event.sources && event.sources.length > 0 && (
            <SourceChip name={event.sources[0]} />
          )}
          {event.last_published_at && <span>{formatRelativeTime(event.last_published_at)}</span>}
        </Metadata>
      </article>
    );
  }

  // Standard card (grid item)
  return (
    <article className={`group flex flex-col border border-divider bg-surface hover:border-slate transition-colors border-l-4 ${accentColor} p-5`}>
      <Kicker type={kicker.type}>{kicker.text}</Kicker>
      <h3 className="font-serif font-bold text-charcoal leading-snug text-xl mb-2 group-hover:text-accent transition-colors">
        <Link
          href={`/events/${event.hash}`}
          onClick={() => onMarkRead?.(event.hash, (event as any).id)}
          className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
        >
          {event.title}
        </Link>
      </h3>
      {event.description && (
        <p className="font-sans text-sm text-charcoal/70 leading-relaxed mb-4 flex-1 line-clamp-3">
          {event.description}
        </p>
      )}
      <div className="flex items-center justify-between pt-3 border-t border-divider">
        <Metadata>
          {event.sources && event.sources.length > 0 && (
            <SourceChip name={event.sources[0]} />
          )}
          {(event.source_count ?? 0) > 1 && (
            <span className="text-slate">+{(event.source_count ?? 0) - 1}</span>
          )}
          <span className="text-divider">·</span>
          <span>{event.article_count} {event.article_count === 1 ? 'article' : 'articles'}</span>
          {!isStale && !isDeveloping && event.last_published_at && (
            <>
              <span className="text-divider">·</span>
              <span>{formatRelativeTime(event.last_published_at)}</span>
            </>
          )}
        </Metadata>
        <FollowButton targetType="event" targetId={event.hash} compact />
      </div>
    </article>
  );
}
