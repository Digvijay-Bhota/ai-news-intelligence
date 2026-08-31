import { Suspense } from 'react';
import { Feed } from '../components/Feed';
import { FeedFilters } from '../components/FeedFilters';

export default function HomePage() {
  return (
    <div className="space-y-6">
      <div className="mb-8">
        <h2 className="text-3xl font-bold text-gray-900 tracking-tight">Latest Intelligence</h2>
        <p className="mt-2 text-lg text-gray-600">Curated AI news, developments, and analysis.</p>
      </div>

      <Suspense fallback={<div className="h-16 bg-gray-100 rounded-lg animate-pulse mb-6"></div>}>
        <FeedFilters />
      </Suspense>

      <Suspense fallback={<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"><div className="h-64 bg-gray-100 rounded-lg animate-pulse"></div></div>}>
        <Feed />
      </Suspense>
    </div>
  );
}
