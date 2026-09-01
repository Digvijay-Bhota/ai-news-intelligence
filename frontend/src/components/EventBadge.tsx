import React from 'react';
import Link from 'next/link';

export function EventBadge({ event }: { event: { title: string; hash?: string } }) {
  const badgeContent = (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800 border border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/20 shadow-sm m-1 transition-colors">
      <span className="w-1.5 h-1.5 bg-amber-500 rounded-full mr-1.5" aria-hidden="true"></span>
      {event.title}
    </span>
  );

  if (event.hash) {
    return (
      <Link href={`/events/${event.hash}`} className="inline-block hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded-full">
        {badgeContent}
      </Link>
    );
  }

  return badgeContent;
}
