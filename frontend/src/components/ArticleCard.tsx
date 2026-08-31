import React, { useState } from 'react';
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
    <article className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden hover:shadow-md transition-shadow duration-200 flex flex-col h-full">
      <div className="p-5 flex-1 flex flex-col">
        <div className="flex justify-between items-start mb-3">
          <span className="text-sm font-semibold text-indigo-600 uppercase tracking-wider">{article.source}</span>
          <div className="flex items-center text-gray-500 text-xs" title={article.published_at ? new Date(article.published_at * 1000).toLocaleString() : undefined}>
            <ClockIcon className="w-3.5 h-3.5 mr-1.5" />
            <time dateTime={article.published_at ? new Date(article.published_at * 1000).toISOString() : undefined}>
              {formatRelativeTime(article.published_at)}
            </time>
          </div>
        </div>

        <h2 className="text-xl font-bold text-gray-900 mb-2 leading-tight">
          <a href={article.url} target="_blank" rel="noopener noreferrer" className="hover:text-indigo-600 hover:underline focus:outline-none focus:ring-2 focus:ring-indigo-500 rounded">
            {article.title}
          </a>
        </h2>

        {article.summary && (
          <p className="text-gray-600 text-sm mb-4 line-clamp-3 leading-relaxed flex-1">
            {article.summary}
          </p>
        )}

        {(!article.summary) && <div className="flex-1" />}

        {(article.topics.length > 0 || article.events.length > 0) && (
          <div className="mt-4 pt-4 border-t border-gray-100">
            <div className="flex flex-wrap -m-1">
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

      <div className="bg-gray-50 px-5 py-3 border-t border-gray-100 flex justify-between items-center">
        <div className="flex space-x-2">
          <button
            onClick={handleSaveToggle}
            disabled={isSaving}
            className={`inline-flex items-center p-1.5 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors ${isSaved ? 'text-indigo-600 bg-indigo-50 hover:bg-indigo-100' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'}`}
            aria-label={isSaved ? "Unsave article" : "Save article"}
            title={isSaved ? "Unsave article" : "Save article"}
          >
            <span className="inline-flex items-center"><BookmarkIcon className="w-5 h-5" solid={isSaved} /></span>
          </button>

          <button
            onClick={handleHide}
            disabled={isHiding}
            className="inline-flex items-center p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors"
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
          className="inline-flex items-center text-sm font-medium text-indigo-600 hover:text-indigo-800 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 rounded px-2 py-1 -mr-2"
          aria-label={`Read full article: ${article.title}`}
        >
          Read article <span className="ml-1.5 inline-flex items-center"><ExternalLinkIcon className="w-4 h-4" /></span>
        </a>
      </div>
    </article>
  );
}
