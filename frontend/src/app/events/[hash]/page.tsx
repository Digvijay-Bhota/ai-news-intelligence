import React from 'react';
import Link from 'next/link';
import { fetchEvent } from '../../../lib/api';
import { ArticleCard } from '../../../components/ArticleCard';
import { ErrorState } from '../../../components/ErrorState';
import { EmptyState } from '../../../components/EmptyState';
import { ChevronLeftIcon } from '../../../components/icons';

export default async function EventPage({ params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  let eventDetail;

  try {
    eventDetail = await fetchEvent(hash);
  } catch (error) {
    return (
      <div className="max-w-4xl mx-auto py-8">
        <ErrorState message="Failed to load the event timeline." />
      </div>
    );
  }

  if (!eventDetail.success || !eventDetail.data) {
    return (
      <div className="max-w-4xl mx-auto py-8 text-center">
        <EmptyState title="Event Not Found" message="This event does not exist or has been removed." />
        <Link href="/" className="mt-4 inline-block text-indigo-600 hover:text-indigo-800">
          Return to Feed
        </Link>
      </div>
    );
  }

  const { event, articles } = eventDetail.data;

  return (
    <div className="max-w-4xl mx-auto">
      <Link href="/" className="inline-flex items-center text-sm font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300 mb-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded">
        <ChevronLeftIcon className="w-4 h-4 mr-1" />
        Back to Feed
      </Link>

      <header className="mb-10 pb-6 border-b border-gray-200 dark:border-gray-800">
        <div className="flex items-center gap-3 mb-3">
          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium uppercase tracking-wide ${
            event.severity === 'critical' ? 'bg-red-100 text-red-800 dark:bg-red-500/10 dark:text-red-400' :
            event.severity === 'warning' ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-500/10 dark:text-yellow-400' :
            'bg-blue-100 text-blue-800 dark:bg-blue-500/10 dark:text-blue-400'
          }`}>
            {event.severity}
          </span>
          {event.started_at && (
            <time className="text-sm text-gray-500 dark:text-gray-400">
              Started {new Date(event.started_at * 1000).toLocaleDateString()}
            </time>
          )}
        </div>
        <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-4 tracking-tight">
          {event.title}
        </h1>
        {event.description && (
          <p className="text-lg text-gray-600 dark:text-gray-300 leading-relaxed max-w-3xl">
            {event.description}
          </p>
        )}
      </header>

      {articles.length === 0 ? (
        <EmptyState title="No articles found" message="There are no articles associated with this event timeline." />
      ) : (
        <div className="relative">
          {/* Vertical timeline line for desktop/tablet */}
          <div className="hidden md:block absolute left-8 top-0 bottom-0 w-px bg-gray-200 dark:bg-gray-800" />
          
          <div className="space-y-8">
            {articles.map((article, index) => (
              <div key={article.id} className="relative md:pl-20">
                {/* Timeline node */}
                <div className="hidden md:flex absolute left-8 -translate-x-1/2 top-6 w-4 h-4 rounded-full bg-indigo-100 dark:bg-indigo-900/50 border-2 border-indigo-500 items-center justify-center">
                  <div className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
                </div>
                
                <ArticleCard article={article} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
