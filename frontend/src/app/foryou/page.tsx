'use client';

import React, { useState, useEffect } from 'react';
import { Feed } from '../../components/Feed';
import Link from 'next/link';

export default function ForYouPage() {
  const [prefTopics, setPrefTopics] = useState<string[]>([]);
  const [prefSources, setPrefSources] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/preferences');
        if (!res.ok) throw new Error('Failed to load preferences');
        const json = await res.json();
        if (json.success && json.data) {
          setPrefTopics(json.data.preferred_topics || []);
          setPrefSources(json.data.preferred_sources || []);
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

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="mb-8">
          <h2 className="text-3xl font-bold text-gray-900 tracking-tight">For You</h2>
          <p className="mt-2 text-lg text-gray-600">Loading your personalized feed...</p>
        </div>
        <div className="h-64 bg-gray-100 rounded-lg animate-pulse"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-3xl py-12 text-center">
        <p className="text-red-500">Failed to load personalized feed.</p>
      </div>
    );
  }

  const hasPreferences = prefTopics.length > 0 || prefSources.length > 0;

  return (
    <div className="space-y-6">
      <div className="mb-8">
        <h2 className="text-3xl font-bold text-gray-900 tracking-tight">For You</h2>
        <p className="mt-2 text-lg text-gray-600">
          Personalized intelligence based on your settings.
        </p>
      </div>

      {!hasPreferences ? (
        <div className="bg-white p-12 rounded-xl shadow-sm border border-gray-200 text-center">
          <h3 className="text-xl font-semibold text-gray-900 mb-2">Your Feed is Empty</h3>
          <p className="text-gray-600 mb-6">
            You haven't selected any preferred topics or sources yet. Customize your settings to get a personalized intelligence feed.
          </p>
          <Link href="/settings" className="inline-flex items-center justify-center px-5 py-3 border border-transparent text-base font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 transition-colors">
            Configure Settings
          </Link>
        </div>
      ) : (
        <Feed topicsOverride={prefTopics} sourceNamesOverride={prefSources} />
      )}
    </div>
  );
}
