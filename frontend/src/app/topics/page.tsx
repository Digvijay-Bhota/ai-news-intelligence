'use client';

import React, { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { fetchTopics } from '../../lib/api';
import { FollowButton } from '../../components/FollowButton';
import type { Topic } from '../../types';

export default function TopicsPage() {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetchTopics();
        if (res.success && res.data) {
          setTopics(res.data.filter(t => t.active === 1));
        } else {
          setError(true);
        }
      } catch (err) {
        console.error(err);
        setError(true);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const filteredTopics = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return topics;
    return topics.filter(t =>
      t.name.toLowerCase().includes(q) || t.slug.toLowerCase().includes(q)
    );
  }, [topics, search]);

  // Group topics alphabetically
  const groupedTopics = useMemo(() => {
    const groups: Record<string, Topic[]> = {};
    for (const t of filteredTopics) {
      const firstChar = t.name.charAt(0).toUpperCase();
      const letter = /^[A-Z]$/.test(firstChar) ? firstChar : '#';
      if (!groups[letter]) groups[letter] = [];
      groups[letter].push(t);
    }
    return Object.keys(groups).sort().reduce((acc, key) => {
      acc[key] = groups[key].sort((a, b) => a.name.localeCompare(b.name));
      return acc;
    }, {} as Record<string, Topic[]>);
  }, [filteredTopics]);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
      {/* Header */}
      <div className="mb-8">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-indigo-100 text-indigo-800 dark:bg-indigo-500/10 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-500/20 uppercase tracking-wide">
                Intelligence Directory
              </span>
              <span className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                {topics.length} Tracked Topics
              </span>
            </div>
            <h1 className="text-3xl font-extrabold text-gray-900 dark:text-gray-50 tracking-tight">
              Topic Explorer
            </h1>
            <p className="mt-1 text-base text-gray-600 dark:text-gray-400">
              Browse and discover news intelligence across automated semantic entity classifications.
            </p>
          </div>

          {/* Search */}
          <div className="w-full sm:w-72">
            <label htmlFor="topic-search" className="sr-only">Search topics</label>
            <div className="relative">
              <input
                id="topic-search"
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search topics (e.g., SpaceX, AI)..."
                className="w-full px-3.5 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  className="absolute right-2.5 top-2.5 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                  aria-label="Clear search"
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="space-y-6">
          <div className="h-12 bg-gray-100 dark:bg-gray-800 rounded-lg animate-pulse" />
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {Array.from({ length: 16 }).map((_, i) => (
              <div key={i} className="h-14 bg-gray-100 dark:bg-gray-800 rounded-lg animate-pulse" />
            ))}
          </div>
        </div>
      ) : error ? (
        <div className="p-12 text-center bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Failed to load topics</h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Unable to retrieve topics at this time.</p>
        </div>
      ) : filteredTopics.length === 0 ? (
        <div className="p-12 text-center bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">No topics match &ldquo;{search}&rdquo;</h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Try searching for a different keyword.</p>
          <button
            onClick={() => setSearch('')}
            className="mt-4 px-3 py-1.5 text-sm font-medium rounded-md bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300"
          >
            Clear Search
          </button>
        </div>
      ) : (
        <div className="space-y-8">
          {Object.entries(groupedTopics).map(([letter, items]) => (
            <section key={letter} aria-labelledby={`letter-${letter}`}>
              <div className="flex items-center gap-3 mb-3 border-b border-gray-200 dark:border-gray-800 pb-1">
                <h2 id={`letter-${letter}`} className="text-base font-bold text-indigo-600 dark:text-indigo-400 font-mono">
                  {letter}
                </h2>
                <span className="text-xs text-gray-400 font-mono">
                  ({items.length})
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2.5">
                {items.map((topic) => (
                  <div
                    key={topic.id}
                    className="group flex items-center justify-between p-2.5 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 hover:border-indigo-400 dark:hover:border-indigo-500/50 hover:shadow-sm transition-all"
                  >
                    <Link
                      href={`/topics/${topic.slug}`}
                      className="flex-1 font-medium text-sm text-gray-900 dark:text-gray-100 hover:text-indigo-600 dark:hover:text-indigo-400 truncate focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded mr-2"
                    >
                      {topic.name}
                    </Link>
                    <FollowButton targetType="topic" targetId={topic.slug} compact />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
