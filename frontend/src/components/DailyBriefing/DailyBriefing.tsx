'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { loadDailyBriefing, MIN_FULL_BRIEFING, type DailyBriefingResult } from '../../lib/dailyBriefing';
import { BriefingStoryCard } from './BriefingStoryCard';
import { DailyBriefingEmpty, DailyBriefingError, DailyBriefingSkeleton } from './BriefingStates';

type State =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; result: DailyBriefingResult };

function todayLabel() {
  return new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

export function DailyBriefing() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    loadDailyBriefing({ signal: controller.signal }).then(
      result => setState({ status: 'ready', result }),
      () => {
        if (!controller.signal.aborted) setState({ status: 'error' });
      },
    );
    return () => controller.abort();
  }, [attempt]);

  const retry = () => {
    setState({ status: 'loading' });
    setAttempt(a => a + 1);
  };

  const stories = state.status === 'ready' ? state.result.stories : [];
  const [lead, ...rest] = stories;

  return (
    <section aria-labelledby="daily-briefing-heading" className="mb-16">
      <header className="mb-8 border-b-2 border-ink pb-5">
        <p suppressHydrationWarning className="font-sans text-xs font-bold uppercase tracking-widest text-slate mb-2">{todayLabel()}</p>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 id="daily-briefing-heading" className="font-serif text-4xl sm:text-5xl font-bold leading-[1.05] text-ink">
              Daily AI Briefing
            </h1>
            <p className="mt-2 max-w-2xl font-sans text-base text-slate">
              The most important AI and technology stories right now — what happened, why it matters, and what changed.
            </p>
          </div>
          {stories.length > 0 && (
            <p className="font-sans text-xs font-semibold uppercase tracking-widest text-slate shrink-0">
              {stories.length} {stories.length === 1 ? 'story' : 'stories'}
            </p>
          )}
        </div>
      </header>

      {state.status === 'loading' && <DailyBriefingSkeleton />}
      {state.status === 'error' && <DailyBriefingError onRetry={retry} />}
      {state.status === 'ready' && stories.length === 0 && <DailyBriefingEmpty />}

      {lead && (
        <div className="space-y-6">
          {stories.length < MIN_FULL_BRIEFING && (
            <p role="note" className="rounded-md border border-divider bg-surface px-4 py-3 font-sans text-sm text-slate">
              Fewer stories are available today — only {stories.length === 1 ? 'one recent story has' : `${stories.length} recent stories have`} a
              completed summary so far.{' '}
              <Link href="/events" className="rounded font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                Browse all events
              </Link>
            </p>
          )}

          <BriefingStoryCard story={lead} lead position={1} />

          {rest.length > 0 && (
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              {rest.map((story, i) => (
                <BriefingStoryCard key={story.hash} story={story} position={i + 2} />
              ))}
            </div>
          )}

          <div className="flex justify-end pt-2">
            <Link
              href="/events"
              className="rounded font-sans text-xs font-bold uppercase tracking-widest text-slate hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              View all events <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>
      )}
    </section>
  );
}
