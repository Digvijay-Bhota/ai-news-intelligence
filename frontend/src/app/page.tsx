import { Suspense } from 'react';
import { Feed } from '../components/Feed';
import { FeedFilters } from '../components/FeedFilters';
import { EventRadarHero } from '../components/EventRadarHero';
import { SectionLabel, Divider } from '../components/Foundations';

export default function HomePage() {
  return (
    <div>
      {/* Event Intelligence Radar */}
      <Suspense fallback={<div className="h-48 bg-divider animate-pulse mb-12" />}>
        <EventRadarHero />
      </Suspense>

      {/* Article Ingestion Stream */}
      <section aria-label="Article ingestion stream">
        <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-2 mb-6">
          <SectionLabel className="mb-0">Article Stream</SectionLabel>
          <p className="font-sans text-xs text-slate uppercase tracking-widest font-semibold">Chronological · Multi-Source</p>
        </div>

        <Suspense fallback={<div className="h-10 bg-divider animate-pulse mb-6 rounded" />}>
          <FeedFilters />
        </Suspense>

        <Divider className="my-6" />

        <Suspense fallback={
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[1,2,3].map(i => <div key={i} className="h-48 bg-divider animate-pulse rounded" />)}
          </div>
        }>
          <Feed />
        </Suspense>
      </section>
    </div>
  );
}
