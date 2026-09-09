'use client';

import React, { useState, useMemo } from 'react';
import type { Article } from '../types';
import { ArticleCard } from './ArticleCard';
import { ClockIcon } from './icons';

interface EventTimelineProps {
  articles: Article[];
  totalArticles?: number;
}

export function EventTimeline({ articles, totalArticles }: EventTimelineProps) {
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [selectedSource, setSelectedSource] = useState<string>('all');

  // Discover all distinct sources from articles
  const availableSources = useMemo(() => {
    const set = new Set<string>();
    for (const a of articles) {
      if (a.source) set.add(a.source);
    }
    return Array.from(set).sort();
  }, [articles]);

  // Compute deterministic timeline milestones on chronologically sorted articles
  const chronologicallyAnnotated = useMemo(() => {
    // Always sort ascending first to compute "First Report by Source" and "Breaking Report" deterministically
    const sorted = [...articles].sort((a, b) => {
      const timeA = a.published_at ?? 0;
      const timeB = b.published_at ?? 0;
      if (timeA !== timeB) return timeA - timeB;
      return a.id - b.id;
    });

    const seenSources = new Set<string>();
    const seenTopics = new Set<string>();

    return sorted.map((article, index) => {
      const isBreaking = index === 0;

      const isFirstForSource = !seenSources.has(article.source);
      if (isFirstForSource) seenSources.add(article.source);

      // What Changed? — new topics introduced
      const newTopics: string[] = [];
      if (article.extracted_entities?.topics) {
        for (const topic of article.extracted_entities.topics) {
          const lower = topic.toLowerCase().trim();
          if (!seenTopics.has(lower)) {
            newTopics.push(topic.trim());
            seenTopics.add(lower);
          }
        }
      }

      return {
        ...article,
        isBreaking,
        isFirstForSource,
        newTopics,
      };
    });
  }, [articles]);

  // Apply user sort & source filter
  const displayedArticles = useMemo(() => {
    let list = [...chronologicallyAnnotated];
    if (selectedSource !== 'all') {
      list = list.filter(a => a.source === selectedSource);
    }
    if (sortOrder === 'desc') {
      list.reverse();
    }
    return list;
  }, [chronologicallyAnnotated, selectedSource, sortOrder]);

  // Group by published date string
  const dateGroups = useMemo(() => {
    const groups: { dateStr: string; items: typeof displayedArticles }[] = [];
    let currentDate = '';
    let currentItems: typeof displayedArticles = [];

    for (const article of displayedArticles) {
      const dateStr = article.published_at
        ? new Date(article.published_at * 1000).toLocaleDateString(undefined, {
            weekday: 'short',
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          })
        : 'Undated';

      if (dateStr !== currentDate) {
        if (currentItems.length > 0) {
          groups.push({ dateStr: currentDate, items: currentItems });
        }
        currentDate = dateStr;
        currentItems = [article];
      } else {
        currentItems.push(article);
      }
    }

    if (currentItems.length > 0) {
      groups.push({ dateStr: currentDate, items: currentItems });
    }

    return groups;
  }, [displayedArticles]);

  if (articles.length === 0) {
    return (
      <div className="p-8 text-center bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800">
        <p className="text-gray-500 dark:text-gray-400 text-sm">
          No articles associated with this story timeline.
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Timeline Controls Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-8 p-4 bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-sm">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            Story Timeline
          </span>
          <span className="text-xs text-indigo-600 dark:text-indigo-400 font-mono font-bold">
            ({displayedArticles.length} {displayedArticles.length === 1 ? 'event report' : 'event reports'})
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Source filter */}
          {availableSources.length > 1 && (
            <div className="flex items-center gap-1.5 text-xs">
              <label htmlFor="timeline-source" className="text-gray-500 dark:text-gray-400">
                Source:
              </label>
              <select
                id="timeline-source"
                value={selectedSource}
                onChange={(e) => setSelectedSource(e.target.value)}
                className="rounded-md border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 py-1 px-2 text-xs text-gray-900 dark:text-gray-100 focus:ring-1 focus:ring-indigo-500"
              >
                <option value="all">All Sources ({availableSources.length})</option>
                {availableSources.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          )}

          {/* Sort toggle */}
          <div className="flex items-center bg-gray-100 dark:bg-gray-800 p-0.5 rounded-lg text-xs font-medium">
            <button
              onClick={() => setSortOrder('asc')}
              className={`px-2.5 py-1 rounded-md transition-colors ${
                sortOrder === 'asc'
                  ? 'bg-white dark:bg-gray-700 text-indigo-600 dark:text-indigo-300 shadow-xs'
                  : 'text-gray-600 dark:text-gray-400 hover:text-gray-900'
              }`}
            >
              Oldest First
            </button>
            <button
              onClick={() => setSortOrder('desc')}
              className={`px-2.5 py-1 rounded-md transition-colors ${
                sortOrder === 'desc'
                  ? 'bg-white dark:bg-gray-700 text-indigo-600 dark:text-indigo-300 shadow-xs'
                  : 'text-gray-600 dark:text-gray-400 hover:text-gray-900'
              }`}
            >
              Newest First
            </button>
          </div>
        </div>
      </div>

      {/* Vertical Timeline Structure */}
      <div className="relative">
        {/* Timeline connector line */}
        <div className="hidden md:block absolute left-8 top-10 bottom-4 w-0.5 bg-indigo-100 dark:bg-gray-800" aria-hidden="true" />

        <div className="space-y-10">
          {dateGroups.map(({ dateStr, items }) => (
            <section key={dateStr} aria-label={`Coverage from ${dateStr}`} className="relative">
              {/* Date Header Node */}
              <div className="sticky top-20 z-10 mb-6 md:pl-20 flex items-center">
                <div className="hidden md:flex absolute left-8 -translate-x-1/2 w-6 h-6 rounded-full bg-white dark:bg-gray-900 border-2 border-indigo-500 items-center justify-center z-10" aria-hidden="true">
                  <div className="w-2 h-2 rounded-full bg-indigo-600 dark:bg-indigo-400" />
                </div>
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-bold bg-white dark:bg-gray-850 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-gray-700 shadow-xs font-mono">
                  <ClockIcon className="w-3.5 h-3.5 text-indigo-500" />
                  <span>{dateStr}</span>
                </div>
              </div>

              {/* Day's articles */}
              <div className="space-y-6">
                {items.map((article) => {
                  const exactTime = article.published_at
                    ? new Date(article.published_at * 1000).toLocaleTimeString(undefined, {
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : null;

                  return (
                    <div key={article.id} className="relative md:pl-20">
                      {/* Timeline dot */}
                      <div className="hidden md:flex absolute left-8 -translate-x-1/2 top-5 w-3.5 h-3.5 rounded-full bg-white dark:bg-gray-900 border-2 border-indigo-300 dark:border-indigo-700 items-center justify-center" aria-hidden="true">
                        <div className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
                      </div>

                      {/* Milestone Badges ("What Changed?") */}
                      <div className="flex flex-wrap items-center gap-2 mb-2.5">
                        {exactTime && (
                          <span className="text-xs font-mono text-gray-400 dark:text-gray-500 font-semibold mr-1">
                            {exactTime}
                          </span>
                        )}

                        {article.isBreaking && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-red-100 text-red-800 dark:bg-red-500/10 dark:text-red-400 border border-red-200 dark:border-red-500/20">
                            🔥 Breaking Report
                          </span>
                        )}

                        {!article.isBreaking && article.isFirstForSource && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-500/10 dark:text-blue-400 border border-blue-200 dark:border-blue-500/20">
                            📰 First report by {article.source}
                          </span>
                        )}

                        {article.newTopics.length > 0 && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/20">
                            🏷️ New: {article.newTopics.slice(0, 3).join(', ')}
                          </span>
                        )}
                      </div>

                      <ArticleCard article={article} />
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>

        {/* Truncation notice */}
        {totalArticles !== undefined && articles.length < totalArticles && (
          <div className="mt-8 md:pl-20">
            <div className="p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg text-center border border-gray-200 dark:border-gray-800">
              <p className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                Displaying first {articles.length} of {totalArticles} total articles in story evolution window.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
