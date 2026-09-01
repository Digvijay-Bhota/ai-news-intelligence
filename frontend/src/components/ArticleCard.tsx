'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import type { Article } from '../types';
import { formatRelativeTime } from '../lib/utils';
import { TopicBadge } from './TopicBadge';
import { EventBadge } from './EventBadge';
import { ClockIcon, ExternalLinkIcon, BookmarkIcon, EyeOffIcon } from './icons';
import { useUserArticles } from '../lib/userArticlesContext';

export function ArticleCard({ article }: { article: Article }) {
  const { savedArticles, saveArticle, unsaveArticle, hideArticle } = useUserArticles();
  const [isSaving, setIsSaving] = useState(false);
  const [isHiding, setIsHiding] = useState(false);

  const isSaved = savedArticles.some(s => s.article.id === article.id);

  const handleSaveToggle = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (isSaving) return;
    setIsSaving(true);
    try {
      if (isSaved) {
        await unsaveArticle(article.id);
      } else {
        await saveArticle(article);
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleHide = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (isHiding) return;
    setIsHiding(true);
    try {
      await hideArticle(article.id);
    } finally {
      setIsHiding(false);
    }
  };

  return (
    <article className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-800 overflow-hidden hover:shadow-md dark:hover:border-gray-700 transition-all duration-200 flex flex-col h-full">
      <div className="p-5 flex-1 flex flex-col">
        <div className="flex justify-between items-start mb-3">
          <span className="text-sm font-semibold text-indigo-600 dark:text-indigo-400 uppercase tracking-wider">{article.source}</span>
          <div className="flex items-center text-gray-500 dark:text-gray-400 text-xs" title={article.published_at ? new Date(article.published_at * 1000).toLocaleString() : undefined}>
            <ClockIcon className="w-3.5 h-3.5 mr-1.5" />
            <time dateTime={article.published_at ? new Date(article.published_at * 1000).toISOString() : undefined}>
              {formatRelativeTime(article.published_at)}
            </time>
          </div>
        </div>

        <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-3 leading-snug">
          <Link href={`/article/${article.id}`} className="hover:text-indigo-600 dark:hover:text-indigo-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:focus-visible:ring-indigo-400 rounded">
            {article.title}
          </Link>
        </h2>

        {article.summary && (
          <p className="text-gray-600 dark:text-gray-300 text-sm mb-4 line-clamp-3 leading-relaxed flex-1">
            {article.summary}
          </p>
        )}

        {(!article.summary) && <div className="flex-1" />}

        {(article.topics.length > 0 || article.events.length > 0) && (
          <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-800">
            <div className="flex flex-wrap gap-1.5">
              {article.events.map((e, idx) => (
                <EventBadge key={idx} event={e} />
              ))}
              {article.topics.map((t, idx) => (
                <TopicBadge key={idx} topic={t} />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="bg-gray-50 dark:bg-gray-900/50 px-5 py-3 border-t border-gray-100 dark:border-gray-800 flex justify-between items-center">
        <div className="flex space-x-2">
          <button
            onClick={handleSaveToggle}
            disabled={isSaving}
            className={`inline-flex items-center p-1.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:focus-visible:ring-indigo-400 transition-colors ${isSaved ? 'text-indigo-600 bg-indigo-50 dark:text-indigo-400 dark:bg-indigo-500/10 hover:bg-indigo-100 dark:hover:bg-indigo-500/20' : 'text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'}`}
            aria-label={isSaved ? "Unsave article" : "Save article"}
            title={isSaved ? "Unsave article" : "Save article"}
          >
            <span className="inline-flex items-center"><BookmarkIcon className="w-5 h-5" solid={isSaved} /></span>
          </button>

          <button
            onClick={handleHide}
            disabled={isHiding}
            className="inline-flex items-center p-1.5 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:focus-visible:ring-indigo-400 transition-colors"
            aria-label="Hide article"
            title="Hide article"
          >
            <span className="inline-flex items-center"><EyeOffIcon className="w-5 h-5" /></span>
          </button>
        </div>

        <a
          href={article.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:focus-visible:ring-indigo-400 rounded px-2 py-1 -mr-2"
          aria-label={`Read full article at source: ${article.title}`}
        >
          Source <span className="ml-1.5 inline-flex items-center"><ExternalLinkIcon className="w-4 h-4" /></span>
        </a>
      </div>
    </article>
  );
}
