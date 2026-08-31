'use client';

import React from 'react';
import { useUserArticles } from '../../lib/userArticlesContext';
import { ArticleCard } from '../../components/ArticleCard';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';

export default function SavedPage() {
  const { savedArticles, isReady } = useUserArticles();

  if (!isReady) {
    return (
      <div className="w-full">
        <h2 className="text-2xl font-bold text-gray-900 mb-6">Saved Articles</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map(i => (
            <LoadingSkeleton key={i} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="w-full">
      <h2 className="text-2xl font-bold text-gray-900 mb-6">Saved Articles</h2>

      {savedArticles.length === 0 ? (
        <div className="text-center py-20 bg-white rounded-xl border border-gray-200">
          <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
          <h3 className="mt-2 text-sm font-semibold text-gray-900">No saved articles</h3>
          <p className="mt-1 text-sm text-gray-500">You haven't saved any articles yet.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {savedArticles.map(saved => (
            <ArticleCard key={saved.article.id} article={saved.article} />
          ))}
        </div>
      )}
    </div>
  );
}
