'use client';

import React, { useState } from 'react';

/**
 * Shares a story link using the browser's native share sheet when available,
 * otherwise copies the link to the clipboard. No network calls or tracking.
 */
export function ShareButton({ path, title, className = '' }: { path: string; title: string; className?: string }) {
  const [status, setStatus] = useState('');

  async function handleShare() {
    const url = new URL(path, window.location.origin).toString();
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title, url });
        return;
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setStatus('Link copied');
    } catch {
      setStatus(`Copy this link: ${url}`);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={handleShare}
        aria-label={`Share story: ${title}`}
        className={`inline-flex items-center gap-1.5 rounded px-2 py-1 font-sans text-xs font-semibold text-slate hover:text-ink hover:bg-divider/60 transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${className}`}
      >
        <svg aria-hidden="true" focusable="false" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
          <path d="M16 6l-4-4-4 4" />
          <path d="M12 2v13" />
        </svg>
        Share
      </button>
      <span role="status" aria-live="polite" className="font-sans text-xs text-slate break-all">
        {status}
      </span>
    </span>
  );
}
