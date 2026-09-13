'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import type { Article } from '../types';
import { formatRelativeTime } from '../lib/utils';
import { ExternalLinkIcon, BookmarkIcon, EyeOffIcon } from './icons';
import { useUserArticles } from '../lib/userArticlesContext';
import { SourceChip } from './Editorial/SourceChip';
import { Metadata } from './Foundations';

export function ArticleCard({ article }: { article: Article }) {
  const { savedArticles, saveArticle, unsaveArticle, hideArticle } = useUserArticles();
  const [isSaving, setIsSaving] = useState(false);
  const [isHiding, setIsHiding] = useState(false);

  const isSaved = savedArticles.some(s => s.article.id === article.id);

  const handleSaveToggle = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (isSaving) return;
    setIsSaving(true);
    try {
      if (isSaved) { await unsaveArticle(article.id); }
      else { await saveArticle(article); }
    } finally { setIsSaving(false); }
  };

  const handleHide = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (isHiding) return;
    setIsHiding(true);
    try { await hideArticle(article.id); }
    finally { setIsHiding(false); }
  };

  return (
    <article className="group flex flex-col border border-divider bg-surface hover:border-slate transition-colors h-full">
      <div className="p-5 flex-1 flex flex-col">
        {/* Source + timestamp */}
        <div className="flex justify-between items-start mb-3">
          <SourceChip name={article.source} url={article.url} />
          <Metadata>
            <time dateTime={article.published_at ? new Date(article.published_at * 1000).toISOString() : undefined} className="text-xs text-slate font-sans">
              {formatRelativeTime(article.published_at)}
            </time>
          </Metadata>
        </div>

        {/* Headline */}
        <h2 className="font-sans font-bold text-charcoal text-base leading-snug mb-2 flex-1 group-hover:text-accent transition-colors">
          <Link
            href={`/article/${article.id}`}
            className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
          >
            {article.title}
          </Link>
        </h2>

        {article.summary && (
          <p className="font-sans text-sm text-charcoal/70 leading-relaxed mb-3 line-clamp-2">
            {article.summary}
          </p>
        )}

        {/* Events linked */}
        {article.events.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {article.events.slice(0, 2).map((ev, idx) => (
              <Link
                key={idx}
                href={`/events/${ev.hash}`}
                className="font-sans text-[10px] font-bold uppercase tracking-widest text-accent border border-accent/30 px-1.5 py-0.5 hover:bg-accent/5 transition-colors"
              >
                {ev.title.length > 28 ? ev.title.slice(0, 28) + '…' : ev.title}
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Footer actions */}
      <div className="border-t border-divider px-5 py-2.5 flex justify-between items-center">
        <div className="flex gap-1">
          <button
            onClick={handleSaveToggle}
            disabled={isSaving}
            aria-label={isSaved ? 'Unsave article' : 'Save article'}
            className={`p-1.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-colors ${isSaved ? 'text-accent' : 'text-slate hover:text-charcoal'}`}
          >
            <BookmarkIcon className="w-4 h-4" solid={isSaved} />
          </button>
          <button
            onClick={handleHide}
            disabled={isHiding}
            aria-label="Hide article"
            className="p-1.5 rounded text-slate hover:text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-colors"
          >
            <EyeOffIcon className="w-4 h-4" />
          </button>
        </div>

        <a
          href={article.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Read full article at source: ${article.title}`}
          className="font-sans text-xs font-bold text-slate hover:text-charcoal uppercase tracking-widest flex items-center gap-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
        >
          Source <ExternalLinkIcon className="w-3.5 h-3.5" />
        </a>
      </div>
    </article>
  );
}
