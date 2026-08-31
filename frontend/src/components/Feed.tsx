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

export function Feed() {
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

  const loadFeed = useCallback(async (isLoadMore = false) => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    try {
      if (isLoadMore) {
        setLoadingMore(true);
      } else {
        setLoading(true);
        setError(null);
      }

      const currentOffset = isLoadMore ? offset : 0;
      const response = await fetchFeed(LIMIT, currentOffset, q, topic, source_id, abortControllerRef.current.signal);

      if (response.success) {
        const newArticles = response.data.items;

        if (isLoadMore) {
          setArticles(prev => [...prev, ...newArticles]);
        } else {
          setArticles(newArticles);
        }

        setOffset(currentOffset + LIMIT);
        setHasMore(currentOffset + newArticles.length < response.data.meta.total);
      } else {
        throw new Error('Invalid response format');
      }
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      setError(err.message || 'Failed to load news feed. Please try again later.');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [offset, q, topic, source_id]);

  useEffect(() => {
    loadFeed(false);
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [q, topic, source_id]);

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
    return <ErrorState message={error} onRetry={() => loadFeed(false)} />;
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
        <div className="mt-10 flex justify-center">
          <button
            onClick={() => loadFeed(true)}
            disabled={loadingMore}
            className="bg-white border border-gray-300 text-gray-700 font-medium py-2.5 px-6 rounded-full hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
          >
            {loadingMore ? (
              <>
                <svg aria-hidden="true" focusable="false" className="animate-spin -ml-1 mr-2 h-4 w-4 text-gray-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
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
