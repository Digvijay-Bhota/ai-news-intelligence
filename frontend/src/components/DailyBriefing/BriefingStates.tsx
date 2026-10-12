import React from 'react';
import Link from 'next/link';

export function DailyBriefingSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-live="polite" className="motion-safe:animate-pulse">
      <span className="sr-only">Loading today&apos;s briefing…</span>
      <div aria-hidden="true" className="space-y-6">
        <div className="overflow-hidden rounded-lg border border-divider bg-surface lg:grid lg:grid-cols-12">
          <div className="aspect-[16/9] bg-divider lg:col-span-5 lg:aspect-auto lg:min-h-72" />
          <div className="space-y-3 p-5 sm:p-8 lg:col-span-7">
            <div className="h-3 w-32 rounded bg-divider" />
            <div className="h-8 w-11/12 rounded bg-divider" />
            <div className="h-8 w-2/3 rounded bg-divider" />
            <div className="h-4 w-full rounded bg-divider" />
            <div className="h-4 w-5/6 rounded bg-divider" />
            <div className="h-4 w-3/4 rounded bg-divider" />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          {[1, 2].map(i => (
            <div key={i} className="overflow-hidden rounded-lg border border-divider bg-surface">
              <div className="aspect-[2/1] bg-divider" />
              <div className="space-y-3 p-5">
                <div className="h-3 w-24 rounded bg-divider" />
                <div className="h-6 w-5/6 rounded bg-divider" />
                <div className="h-4 w-full rounded bg-divider" />
                <div className="h-4 w-2/3 rounded bg-divider" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function DailyBriefingError({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="rounded-lg border border-divider border-l-4 border-l-breaking bg-surface p-6 sm:p-8">
      <h2 className="font-serif text-xl font-bold text-ink mb-2">Today&apos;s briefing couldn&apos;t load</h2>
      <p className="font-sans text-sm text-slate mb-5">
        This is usually temporary. Try again, or browse all events in the meantime.
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md bg-ink px-4 py-2 font-sans text-sm font-semibold text-paper hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
        >
          Try again
        </button>
        <Link href="/events" className="rounded font-sans text-sm font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          Browse all events
        </Link>
      </div>
    </div>
  );
}

export function DailyBriefingEmpty() {
  return (
    <div className="rounded-lg border border-dashed border-divider bg-surface px-6 py-12 text-center">
      <h2 className="font-serif text-xl font-bold text-ink mb-2">No briefing stories yet today</h2>
      <p className="mx-auto max-w-md font-sans text-sm text-slate mb-5">
        Stories appear here once recent events have a completed, source-grounded summary. Recent coverage is still available below and on the events page.
      </p>
      <Link href="/events" className="inline-block rounded-md border border-ink px-4 py-2 font-sans text-sm font-semibold text-ink hover:bg-ink hover:text-paper transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        Browse all events
      </Link>
    </div>
  );
}
