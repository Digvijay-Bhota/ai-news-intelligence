'use client';

import React from 'react';
import Link from 'next/link';
import type { BriefingStory } from '../../lib/dailyBriefing';
import { formatRelativeTime } from '../../lib/utils';
import { ShareButton } from '../ShareButton';
import { StoryVisual } from './StoryVisual';

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function StoryField({ label, children, lead }: { label: string; children: React.ReactNode; lead: boolean }) {
  return (
    <div>
      <dt className="font-sans text-[11px] font-bold uppercase tracking-widest text-accent mb-1">{label}</dt>
      <dd className={`text-charcoal leading-relaxed ${lead ? 'font-serif text-base' : 'font-sans text-sm'}`}>{children}</dd>
    </div>
  );
}

export function BriefingStoryCard({ story, lead = false, position }: { story: BriefingStory; lead?: boolean; position: number }) {
  const href = `/events/${story.hash}`;
  const titleId = `briefing-story-${story.hash}`;
  const kicker = story.isCritical ? 'Critical' : story.isDeveloping ? 'Developing' : null;
  const HeadingTag = lead ? 'h2' : 'h3';

  return (
    <article
      aria-labelledby={titleId}
      className={`group flex flex-col overflow-hidden rounded-lg border border-divider bg-surface shadow-sm transition-[border-color,box-shadow] motion-reduce:transition-none hover:border-slate hover:shadow-md focus-within:border-slate ${lead ? 'lg:grid lg:grid-cols-12' : ''}`}
    >
      <StoryVisual
        seed={story.hash}
        label={story.topics[0] ?? null}
        priority={lead}
        className={lead ? 'aspect-[16/9] lg:aspect-auto lg:col-span-5 lg:min-h-full' : 'aspect-[2/1]'}
      />

      <div className={`flex flex-1 flex-col ${lead ? 'p-5 sm:p-8 lg:col-span-7' : 'p-5'}`}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-sans text-[11px] font-bold uppercase tracking-widest text-slate mb-2">
          <span className="text-ink tabular-nums" aria-hidden="true">{String(position).padStart(2, '0')}</span>
          {kicker && <span className={story.isCritical ? 'text-breaking' : 'text-developing'}>{kicker}</span>}
          {story.topics.map(t => (
            <span key={t} className="rounded-sm bg-divider/70 px-1.5 py-0.5 text-charcoal normal-case tracking-normal font-semibold">{t}</span>
          ))}
          {story.lastActivityAt !== null && (
            <time dateTime={new Date(story.lastActivityAt * 1000).toISOString()} className="normal-case tracking-normal font-medium">
              Updated {formatRelativeTime(story.lastActivityAt)}
            </time>
          )}
        </div>

        <HeadingTag id={titleId} className={`font-serif font-bold text-ink leading-tight mb-3 ${lead ? 'text-2xl sm:text-3xl lg:text-4xl' : 'text-xl'}`}>
          <Link href={href} className="rounded decoration-accent/60 underline-offset-4 group-hover:underline hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            {story.title}
          </Link>
        </HeadingTag>

        <p className={`text-charcoal/90 leading-relaxed mb-5 ${lead ? 'font-serif text-lg' : 'font-sans text-sm line-clamp-4'}`}>
          {story.summary}
        </p>

        <dl className={`space-y-4 mb-5 ${lead ? '' : 'flex-1'}`}>
          {story.whyItMatters && <StoryField label="Why it matters" lead={lead}>{story.whyItMatters}</StoryField>}
          {story.change && <StoryField label={story.change.label} lead={lead}>{story.change.text}</StoryField>}
          {story.uncertainty && <StoryField label="What's uncertain" lead={lead}>{story.uncertainty}</StoryField>}
          {story.entities.length > 0 && (
            <div>
              <dt className="font-sans text-[11px] font-bold uppercase tracking-widest text-accent mb-1.5">Who&apos;s involved</dt>
              <dd>
                <ul className="flex flex-wrap gap-1.5" aria-label="Who's involved">
                  {story.entities.map(e => (
                    <li key={e.name} className="inline-flex items-center gap-1 rounded-full border border-divider bg-paper px-2.5 py-0.5 font-sans text-xs text-charcoal">
                      <span className="font-semibold">{e.name}</span>
                      {e.type && <span className="text-slate">· {e.type}</span>}
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          )}
        </dl>

        {story.briefOutdated && (
          <p className="mb-4 font-sans text-xs text-slate">
            This summary was written before the latest reports; the full story lists every source.
          </p>
        )}

        <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-divider pt-4 font-sans text-xs text-slate">
          <Link
            href={`${href}#source-material`}
            aria-label={`${plural(story.sourceCount, 'source')} and ${plural(story.articleCount, 'article')} for: ${story.title}`}
            className="rounded font-semibold hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {plural(story.sourceCount, 'source')} · {plural(story.articleCount, 'article')}
          </Link>
          {story.citationCount > 0 && (
            <Link
              href={`${href}#evidence-sources`}
              aria-label={`${plural(story.citationCount, 'citation')} for: ${story.title}`}
              className="rounded font-semibold hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {plural(story.citationCount, 'citation')}
            </Link>
          )}
          <ShareButton path={href} title={story.title} />
          <Link
            href={href}
            aria-label={`Read the full story: ${story.title}`}
            className="ml-auto rounded font-bold uppercase tracking-widest text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Full story <span aria-hidden="true">→</span>
          </Link>
        </div>
      </div>
    </article>
  );
}
