import React from 'react';
import type { Article } from '../types';
import { formatRelativeTime } from '../lib/utils';
import { TopicBadge } from './TopicBadge';
import { EventBadge } from './EventBadge';
import { ClockIcon, ExternalLinkIcon } from './icons';

export function ArticleCard({ article }: { article: Article }) {
  return (
    <article className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden hover:shadow-md transition-shadow duration-200 flex flex-col h-full">
      <div className="p-5 flex-1 flex flex-col">
        <div className="flex justify-between items-start mb-3">
          <span className="text-sm font-semibold text-indigo-600 uppercase tracking-wider">{article.source}</span>
          <div className="flex items-center text-gray-500 text-xs" title={article.published_at ? new Date(article.published_at * 1000).toLocaleString() : undefined}>
            <ClockIcon className="w-3.5 h-3.5 mr-1" />
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
            <div className="flex flex-wrap gap-2">
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

      <div className="bg-gray-50 px-5 py-3 border-t border-gray-100 flex justify-end">
        <a
          href={article.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center text-sm font-medium text-indigo-600 hover:text-indigo-800 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 rounded px-2 py-1 -mr-2"
          aria-label={`Read full article: ${article.title}`}
        >
          Read article <ExternalLinkIcon className="w-4 h-4 ml-1.5" />
        </a>
      </div>
    </article>
  );
}
