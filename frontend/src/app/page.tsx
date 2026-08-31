'use client';

import { useEffect, useState } from 'react';
import { fetchFeed } from '../lib/api';

export default function HomePage() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchFeed()
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-6">
      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-2xl font-bold mb-4">Frontend Worker M7-A</h2>
        <p className="text-gray-600 mb-4">
          This is a placeholder proving that the Next.js frontend worker successfully renders!
        </p>
      </div>

      <div className="bg-white shadow rounded-lg p-6">
        <h3 className="text-lg font-semibold mb-4">Backend Connection Test</h3>
        {loading && <div className="animate-pulse text-gray-400">Fetching feed from BFF...</div>}
        {error && <div className="text-red-500">Error: {error}</div>}
        {data && (
          <div className="space-y-2">
            <p className="text-green-600 font-medium">Successfully fetched feed!</p>
            <pre className="bg-gray-100 p-4 rounded text-xs overflow-auto max-h-64">
              {JSON.stringify(data, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
