import React from 'react';

export function TopicBadge({ topic }: { topic: string }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-500/10 dark:text-blue-300 m-1 border border-transparent dark:border-blue-500/20">
      {topic}
    </span>
  );
}
