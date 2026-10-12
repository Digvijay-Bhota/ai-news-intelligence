'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { useUserArticles } from '../lib/userArticlesContext';
import { fetchFeed } from '../lib/api';
import type { Article } from '../types';
import { ArticleCard } from './ArticleCard';
import { LoadingSkeleton } from './LoadingSkeleton';
import { ErrorState } from './ErrorState';
import { EmptyState } from './EmptyState';

const LIMIT = 20;

interface FeedProps {
  topicsOverride?: string[];
  sourceNamesOverride?: string[];
}

export function Feed({ topicsOverride, sourceNamesOverride }: FeedProps = {}) {
  const searchParams = useSearchParams();
  const q = searchParams.get('q') || undefined;
  const topic = searchParams.get('topic') || undefined;
  const source_id = searchParams.get('source_id') || undefined;

  const [articles, setArticles] = useState<Article[]>([]);
  const { hiddenArticleIds } = useUserArticles();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [offset, setOffset] = useState(0);

  const abortControllerRef = useRef<AbortController | null>(null);

  // A filter change starts over from the loading state (adjusted during render;
  // the effect below then loads the first page for the new filters).
  const filters = { q, topic, source_id, topicsOverride, sourceNamesOverride };
  const [shownFilters, setShownFilters] = useState(filters);
  if ((Object.keys(filters) as (keyof typeof filters)[]).some(key => filters[key] !== shownFilters[key])) {
    setShownFilters(filters);
    setLoading(true);
    setError(null);
  }

  // Loads the page at pageOffset, replacing or appending to the list. State
  // changes only when the request settles; a newer request aborts this one.
  const requestFeed = useCallback((pageOffset: number, append: boolean) => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    return fetchFeed(
      LIMIT, pageOffset, q, topic, source_id,
      topicsOverride, sourceNamesOverride,
      controller.signal
    )
      .then(response => {
        if (!response.success) throw new Error('Invalid response format');
        const newArticles = response.data.items;
        setArticles(prev => (append ? [...prev, ...newArticles] : newArticles));
        setOffset(pageOffset + LIMIT);
        setHasMore(pageOffset + newArticles.length < response.data.meta.total);
      })
      .catch((err: unknown) => {
        const isObject = typeof err === 'object' && err !== null;
        if (isObject && 'name' in err && err.name === 'AbortError') return;
        const message = isObject && 'message' in err && typeof err.message === 'string' ? err.message : '';
        setError(message || 'Failed to load news feed. Please try again later.');
      })
      .finally(() => {
        setLoading(false);
        setLoadingMore(false);
      });
  }, [q, topic, source_id, topicsOverride, sourceNamesOverride]);

  useEffect(() => {
    requestFeed(0, false);
    return () => {
      abortControllerRef.current?.abort();
    };
  }, [requestFeed]);

  const retry = () => {
    setLoading(true);
    setError(null);
    requestFeed(0, false);
  };

  const loadMore = () => {
    setLoadingMore(true);
    requestFeed(offset, true);
  };

  if (loading) {
    return (
      <div className="w-full">
        <h2 className="sr-only">News Feed Loading</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3, 4, 5, 6].map(i => (
            <LoadingSkeleton key={i} />
          ))}
        </div>
      </div>
    );
  }

  if (error && articles.length === 0) {
    return <ErrorState message={error} onRetry={retry} />;
  }

  const visibleArticles = articles.filter(a => !hiddenArticleIds.has(a.id));

  if (!loading && visibleArticles.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="w-full">
      <h2 className="sr-only">News Feed</h2>

      {error && (
        <div className="mb-6">
          <ErrorState message={error} />
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {visibleArticles.map((article) => (
          <ArticleCard key={article.id} article={article} />
        ))}
      </div>

      {hasMore && (
        <div className="mt-12 flex justify-center">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="w-full sm:w-auto bg-surface border border-divider text-charcoal font-sans font-bold text-xs uppercase tracking-widest py-3 px-8 hover:border-slate transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 disabled:cursor-not-allowed flex justify-center items-center"
          >
            {loadingMore ? (
              <>
                <svg role="presentation" aria-hidden="true" focusable="false" className="animate-spin -ml-1 mr-3 h-5 w-5 text-gray-500 dark:text-gray-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Loading more...
              </>
            ) : (
              'Load more articles'
            )}
          </button>
        </div>
      )}
    </div>
  );
}
