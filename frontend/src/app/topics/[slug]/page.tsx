'use client';

import React, { useState, useEffect } from 'react';
import { Feed } from '../../../components/Feed';
import { fetchTopics } from '../../../lib/api';
import Link from 'next/link';

export default function TopicPage({ params }: { params: Promise<{ slug: string }> }) {
  const [slug, setSlug] = useState<string | null>(null);
  const [topicName, setTopicName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const p = await params;
        setSlug(p.slug);
        const res = await fetchTopics();
        if (res.success && res.data) {
          const found = res.data.find(t => t.slug === p.slug);
          if (found) setTopicName(found.name);
          else setError(true); // Topic not found
        }
      } catch (err) {
        console.error(err);
        setError(true);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [params]);

  if (loading || !slug) {
    return (
      <div className="space-y-6">
        <div className="h-10 w-48 bg-gray-200 rounded animate-pulse mb-8"></div>
        <div className="h-64 bg-gray-100 rounded-lg animate-pulse"></div>
      </div>
    );
  }

  if (error || !topicName) {
    return (
      <div className="max-w-3xl mx-auto py-12 text-center">
        <h1 className="text-2xl font-bold text-gray-900">Topic Not Found</h1>
        <p className="mt-2 text-gray-600">The topic you're looking for does not exist.</p>
        <Link href="/" className="mt-4 inline-block text-indigo-600 hover:text-indigo-800">
          Return to Feed
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="mb-8">
        <Link href="/" className="text-sm font-medium text-indigo-600 hover:text-indigo-800 mb-4 inline-block">
          &larr; Back to Feed
        </Link>
        <h2 className="text-3xl font-bold text-gray-900 tracking-tight">{topicName}</h2>
        <p className="mt-2 text-lg text-gray-600">
          Latest intelligence and updates for {topicName}.
        </p>
      </div>

      <Feed topicsOverride={[slug]} />
    </div>
  );
}
