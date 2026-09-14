'use client';
import React, { useState, useEffect } from 'react';

export function CommunityPulse({ eventHash }: { eventHash: string }) {
  const [pulse, setPulse] = useState<any>(null);

  useEffect(() => {
    async function fetchPulse() {
      try {
        const res = await fetch(`/api/v1/events/${eventHash}/community/intelligence`);
        if (res.ok) {
          const data = await res.json();
          setPulse(data.data?.metrics);
        }
      } catch (e) {
        // ignore
      }
    }
    fetchPulse();
  }, [eventHash]);

  if (!pulse) return null;
  if (pulse.lifetime_posts === 0) return null;

  const isHighlyActive = pulse.momentum_score > 5;
  const isActive = pulse.momentum_score > 0 && pulse.momentum_score <= 5;

  return (
    <div className="mb-8 p-4 bg-indigo-50 dark:bg-indigo-900/20 rounded-lg border border-indigo-100 dark:border-indigo-800">
      <h3 className="text-sm font-semibold text-indigo-800 dark:text-indigo-300 mb-3 uppercase tracking-wider">Community Pulse</h3>
      <div className="flex space-x-6">
        <div className="flex flex-col">
          <span className="text-2xl font-bold text-gray-900 dark:text-white">{pulse.lifetime_participants}</span>
          <span className="text-sm text-gray-500 dark:text-gray-400">Participants</span>
        </div>
        <div className="flex flex-col">
          <span className="text-2xl font-bold text-gray-900 dark:text-white">{pulse.lifetime_posts}</span>
          <span className="text-sm text-gray-500 dark:text-gray-400">Total posts</span>
        </div>
        <div className="flex flex-col">
          <span className="text-2xl font-bold text-gray-900 dark:text-white">{pulse.posts_last_24h}</span>
          <span className="text-sm text-gray-500 dark:text-gray-400">Posts in last 24h</span>
        </div>
      </div>
      {(isHighlyActive || isActive) && (
        <div className="mt-3 text-sm font-medium text-indigo-700 dark:text-indigo-400">
          {isHighlyActive ? 'Discussion is highly active ↑' : 'Active discussion ↑'}
        </div>
      )}
    </div>
  );
}
