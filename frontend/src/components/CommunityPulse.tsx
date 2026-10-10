'use client';
import React, { useState, useEffect } from 'react';

interface Signal {
  type: string;
  content: string;
  evidence_count: number;
  [key: string]: any; // Allow for other fields but we won't render them
}

function getSignalLabel(type: string): string | null {
  switch (type) {
    case 'emerging_theme': return 'Several community members are discussing...';
    case 'common_question': return 'Common question emerging from the community...';
    case 'divergent_view': return 'Divergent views are appearing around...';
    default: return null;
  }
}

export function CommunityPulse({ eventHash }: { eventHash: string }) {
  const [pulse, setPulse] = useState<any>(null);
  const [signals, setSignals] = useState<Signal[]>([]);

  useEffect(() => {
    async function fetchPulse() {
      try {
        const res = await fetch(`/api/v1/events/${eventHash}/community/intelligence`);
        if (res.ok) {
          const data = await res.json();
          setPulse(data.data?.metrics);
          setSignals(data.data?.signals || []);
        }
      } catch (e) {
        // ignore
      }
    }
    fetchPulse();
  }, [eventHash]);

  if (!pulse) return null;
  if (pulse.lifetime_posts === 0 && signals.length === 0) return null;

  const isHighlyActive = pulse.momentum_score > 5;
  const isActive = pulse.momentum_score > 0 && pulse.momentum_score <= 5;

  return (
    <div className="mb-8 p-4 bg-indigo-50 dark:bg-indigo-900/20 rounded-lg border border-indigo-100 dark:border-indigo-800">
      <h3 className="text-sm font-semibold text-indigo-800 dark:text-indigo-300 mb-3 uppercase tracking-wider">Community Pulse</h3>
      <div className="flex space-x-6">
        <div className="flex flex-col">
          <span className="text-2xl font-bold text-gray-900 dark:text-white">{pulse.lifetime_participants || 0}</span>
          <span className="text-sm text-gray-500 dark:text-gray-400">Participants</span>
        </div>
        <div className="flex flex-col">
          <span className="text-2xl font-bold text-gray-900 dark:text-white">{pulse.lifetime_posts || 0}</span>
          <span className="text-sm text-gray-500 dark:text-gray-400">Total posts</span>
        </div>
        <div className="flex flex-col">
          <span className="text-2xl font-bold text-gray-900 dark:text-white">{pulse.posts_last_24h || 0}</span>
          <span className="text-sm text-gray-500 dark:text-gray-400">Posts in last 24h</span>
        </div>
      </div>
      {(isHighlyActive || isActive) && (
        <div className="mt-3 text-sm font-medium text-indigo-700 dark:text-indigo-400">
          {isHighlyActive ? 'Discussion is highly active ↑' : 'Active discussion ↑'}
        </div>
      )}

      {signals && signals.length > 0 && (
        <div className="mt-6 pt-4 border-t border-indigo-200 dark:border-indigo-800/60">
          <h4 className="text-xs font-semibold text-indigo-800 dark:text-indigo-300 mb-4 uppercase tracking-wider">Community Intelligence</h4>
          <ul className="space-y-4">
            {signals.map((sig, idx) => {
              const label = getSignalLabel(sig.type);
              if (!label) return null;
              return (
                <li key={idx} className="text-sm">
                  <div className="font-medium text-indigo-900 dark:text-indigo-200 mb-1">{label}</div>
                  <div className="text-gray-800 dark:text-gray-300 italic">"{sig.content}"</div>
                  {typeof sig.evidence_count === 'number' && sig.evidence_count > 0 && (
                    <div className="mt-1.5 text-xs text-indigo-600 dark:text-indigo-400 font-medium opacity-80">
                      Based on {sig.evidence_count} posts
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
