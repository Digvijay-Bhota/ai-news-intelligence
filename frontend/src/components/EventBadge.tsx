import React from 'react';

export function EventBadge({ event }: { event: string }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800 border border-amber-200 shadow-sm">
      <span className="w-1.5 h-1.5 bg-amber-500 rounded-full mr-1.5" aria-hidden="true"></span>
      {event}
    </span>
  );
}
