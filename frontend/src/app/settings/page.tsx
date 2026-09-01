'use client';

import React, { useState, useEffect } from 'react';
import { fetchTopics, fetchSources } from '../../lib/api';
import type { Topic, Source } from '../../types';

export default function SettingsPage() {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  
  const [prefTopics, setPrefTopics] = useState<string[]>([]);
  const [prefSources, setPrefSources] = useState<string[]>([]);
  const [digestFreq, setDigestFreq] = useState<string>('daily');
  
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{type: 'success' | 'error', text: string} | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [topicsRes, sourcesRes, prefsRes] = await Promise.all([
          fetchTopics(),
          fetchSources(),
          fetch('/api/preferences').then(r => r.ok ? r.json() : null)
        ]);

        if (topicsRes.success) setTopics(topicsRes.data || []);
        if (sourcesRes.success) setSources(sourcesRes.data || []);

        if (prefsRes?.success && prefsRes.data) {
          setPrefTopics(prefsRes.data.preferred_topics || []);
          setPrefSources(prefsRes.data.preferred_sources || []);
          setDigestFreq(prefsRes.data.digest_frequency || 'daily');
        }
      } catch (err) {
        console.error('Failed to load settings', err);
        setMessage({ type: 'error', text: 'Failed to load settings.' });
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preferred_topics: prefTopics,
          preferred_sources: prefSources,
          digest_frequency: digestFreq
        })
      });
      if (!res.ok) throw new Error('Save failed');
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Save failed');
      
      setMessage({ type: 'success', text: 'Preferences saved successfully!' });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Failed to save.' });
    } finally {
      setSaving(false);
    }
  };

  const toggleTopic = (slug: string) => {
    setPrefTopics(prev => prev.includes(slug) ? prev.filter(t => t !== slug) : [...prev, slug]);
  };

  const toggleSource = (name: string) => {
    setPrefSources(prev => prev.includes(name) ? prev.filter(s => s !== name) : [...prev, name]);
  };

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto py-12 px-4">
        <h1 className="text-3xl font-bold text-gray-900 mb-8">Settings</h1>
        <div className="animate-pulse space-y-6">
          <div className="h-40 bg-gray-100 rounded-lg"></div>
          <div className="h-40 bg-gray-100 rounded-lg"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto py-12 px-4 sm:px-6">
      <h1 className="text-3xl font-extrabold text-gray-900 mb-2">Settings</h1>
      <p className="text-gray-600 mb-8">Customize your AI News Intelligence experience.</p>
      
      {message && (
        <div className={`mb-6 p-4 rounded-md ${message.type === 'success' ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-red-50 text-red-800 border border-red-200'}`}>
          {message.text}
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-10 bg-white p-6 sm:p-8 rounded-xl shadow-sm border border-gray-200">
        
        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-4">Preferred Topics</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {topics.map(t => (
              <label key={t.slug} className="relative flex items-start p-4 cursor-pointer border rounded-lg hover:bg-gray-50 transition-colors">
                <div className="flex items-center h-5">
                  <input
                    type="checkbox"
                    className="h-4 w-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                    checked={prefTopics.includes(t.slug)}
                    onChange={() => toggleTopic(t.slug)}
                  />
                </div>
                <div className="ml-3 text-sm">
                  <span className="font-medium text-gray-900">{t.name}</span>
                </div>
              </label>
            ))}
            {topics.length === 0 && <p className="text-gray-500 text-sm">No topics available.</p>}
          </div>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-4">Preferred Sources</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {sources.map(s => (
              <label key={s.id} className="relative flex items-start p-4 cursor-pointer border rounded-lg hover:bg-gray-50 transition-colors">
                <div className="flex items-center h-5">
                  <input
                    type="checkbox"
                    className="h-4 w-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                    checked={prefSources.includes(s.name)}
                    onChange={() => toggleSource(s.name)}
                  />
                </div>
                <div className="ml-3 text-sm">
                  <span className="font-medium text-gray-900">{s.name}</span>
                </div>
              </label>
            ))}
            {sources.length === 0 && <p className="text-gray-500 text-sm">No sources available.</p>}
          </div>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-4">Digest Frequency</h2>
          <select 
            value={digestFreq}
            onChange={e => setDigestFreq(e.target.value)}
            className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm rounded-md"
          >
            <option value="realtime">Real-time (As it happens)</option>
            <option value="daily">Daily Digest</option>
            <option value="weekly">Weekly Digest</option>
            <option value="none">No Emails</option>
          </select>
        </section>

        <div className="pt-5 border-t border-gray-200">
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="inline-flex justify-center py-2.5 px-6 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving...' : 'Save Preferences'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
