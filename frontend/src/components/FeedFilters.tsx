'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { fetchTopics, fetchSources } from '../lib/api';
import type { Topic, Source } from '../types';

export function FeedFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [topics, setTopics] = useState<Topic[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  
  const currentQ = searchParams.get('q') || '';
  const currentTopic = searchParams.get('topic') || '';
  const currentSource = searchParams.get('source_id') || '';

  const [localQ, setLocalQ] = useState(currentQ);

  const debounceTimer = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    let mounted = true;
    Promise.all([fetchTopics(), fetchSources()])
      .then(([topicsRes, sourcesRes]) => {
        if (mounted) {
          if (topicsRes.success) setTopics(topicsRes.data);
          if (sourcesRes.success) setSources(sourcesRes.data);
        }
      })
      .catch(err => console.error('Failed to load metadata:', err));
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    setLocalQ(currentQ);
  }, [currentQ]);

  const updateFilters = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    router.push(`${pathname}?${params.toString()}`);
  };

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setLocalQ(val);

    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }
    debounceTimer.current = setTimeout(() => {
      updateFilters('q', val);
    }, 500);
  };

  const handleClearSearch = () => {
    setLocalQ('');
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    updateFilters('q', '');
  };

  const hasFilters = currentQ || currentTopic || currentSource;

  return (
    <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-200 mb-6 flex flex-col md:flex-row gap-4">
      <div className="flex-grow relative">
        <label htmlFor="search" className="sr-only">Search</label>
        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
          <svg className="h-5 w-5 text-gray-400" aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
        <input
          id="search"
          type="text"
          value={localQ}
          onChange={handleSearchChange}
          placeholder="Search articles..."
          className="block w-full pl-10 pr-10 py-2 border border-gray-300 rounded-md leading-5 bg-white placeholder-gray-500 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
        />
        {localQ && (
          <button
            onClick={handleClearSearch}
            className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-500"
            aria-label="Clear search"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      <div className="flex gap-4">
        <select
          value={currentTopic}
          onChange={(e) => updateFilters('topic', e.target.value)}
          className="block w-full md:w-48 pl-3 pr-10 py-2 text-base border border-gray-300 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm rounded-md"
          aria-label="Filter by Topic"
        >
          <option value="">All Topics</option>
          {topics.map(t => (
            <option key={t.id} value={t.slug}>{t.name}</option>
          ))}
        </select>

        <select
          value={currentSource}
          onChange={(e) => updateFilters('source_id', e.target.value)}
          className="block w-full md:w-48 pl-3 pr-10 py-2 text-base border border-gray-300 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm rounded-md"
          aria-label="Filter by Source"
        >
          <option value="">All Sources</option>
          {sources.map(s => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>

      {hasFilters && (
        <div className="flex items-center">
          <button
            onClick={() => router.push(pathname)}
            className="text-sm text-indigo-600 hover:text-indigo-900 font-medium whitespace-nowrap"
          >
            Clear All
          </button>
        </div>
      )}
    </div>
  );
}
