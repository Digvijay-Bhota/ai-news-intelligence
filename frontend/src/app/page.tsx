import { Suspense } from 'react';
import { Feed } from '../components/Feed';
import { FeedFilters } from '../components/FeedFilters';
import { EventRadarHero } from '../components/EventRadarHero';

export default function HomePage() {
  return (
    <div className="space-y-8">
      {/* ── 1. Live Event Intelligence Radar (Primary Focus) ─────── */}
      <Suspense fallback={<div className="h-64 bg-indigo-50/40 dark:bg-gray-800/40 rounded-2xl animate-pulse mb-8" />}>
        <EventRadarHero />
      </Suspense>

      {/* ── 2. Real-Time Ingestion Stream ────────────────────────── */}
      <section aria-label="Ingestion Stream" className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-2 border-b border-gray-200 dark:border-gray-800 pb-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300 uppercase tracking-wide">
                Raw Stream
              </span>
              <span className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                Multi-Source Ingestion
              </span>
            </div>
            <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 tracking-tight">
              Article Ingestion Feed
            </h2>
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Chronological dispatch of newly normalized intelligence reports
          </p>
        </div>

        <Suspense fallback={<div className="h-16 bg-gray-100 dark:bg-gray-800 rounded-lg animate-pulse mb-6"></div>}>
          <FeedFilters />
        </Suspense>

        <Suspense fallback={<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"><div className="h-64 bg-gray-100 dark:bg-gray-800 rounded-lg animate-pulse"></div></div>}>
          <Feed />
        </Suspense>
      </section>
    </div>
  );
}
