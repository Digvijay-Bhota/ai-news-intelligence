import React from 'react';

export function EmptyState() {
  return (
    <div className="text-center py-16 px-4 bg-white rounded-xl shadow-sm border border-gray-100 w-full">
      <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-gray-100 mb-4">
        <svg role="presentation" aria-hidden="true" focusable="false" className="w-8 h-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9.5L18.5 7H20" />
        </svg>
      </div>
      <h3 className="text-xl font-medium text-gray-900 mb-1">No articles found</h3>
      <p className="text-gray-500">We couldn't find any news articles at the moment. Please check back later.</p>
    </div>
  );
}
