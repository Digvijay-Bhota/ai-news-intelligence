/**
 * ClaimComparisonCard — Phase 10: Cross-Source Intelligence UX
 *
 * Visualizes claim consensus, conflicting reporting, and source positioning.
 * Allows analysts to compare how different newsrooms report the same development.
 */

import React from 'react';
import { ClaimComparison, ClaimComparisonMetadata, Article } from '../types';

interface ClaimComparisonCardProps {
  claim_comparisons: ClaimComparison[];
  claim_comparison_metadata: ClaimComparisonMetadata | null;
  articles?: Article[];
}

function ClaimStatusBadge({ status }: { status: string }) {
  const norm = status.toLowerCase();
  let classes = 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border-gray-200 dark:border-gray-700';
  let label = status;

  if (norm === 'consensus') {
    classes = 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300 border-emerald-200 dark:border-emerald-500/20';
    label = 'Newsroom Consensus';
  } else if (norm === 'disputed') {
    classes = 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300 border-rose-200 dark:border-rose-500/20';
    label = 'Conflicting Coverage';
  } else if (norm === 'evolving') {
    classes = 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300 border-blue-200 dark:border-blue-500/20';
    label = 'Rapidly Evolving';
  } else if (norm === 'unconfirmed') {
    classes = 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300 border-amber-200 dark:border-amber-500/20';
    label = 'Single-Source / Unconfirmed';
  }

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border ${classes}`}>
      {label}
    </span>
  );
}

export function ClaimComparisonCard({
  claim_comparisons,
  claim_comparison_metadata: _metadata,
  articles = [],
}: ClaimComparisonCardProps) {
  // Article lookup map for links
  const articleById = new Map<number, Article>();
  for (const a of articles) {
    articleById.set(a.id, a);
  }

  if (!claim_comparisons || claim_comparisons.length === 0) {
    return (
      <section
        aria-label="Cross-Source Claim Intelligence"
        className="mb-8 p-6 bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-sm"
      >
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-purple-400" aria-hidden="true" />
            <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">
              Cross-Source Intelligence
            </h2>
          </div>
          <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 border border-gray-200 dark:border-gray-700 uppercase">
            Awaiting Multi-Source Depth
          </span>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
          Cross-source claim comparison activates when multiple independent newsrooms report on this story. As additional sources cover this event, reporting consensus and contradictions will be analyzed automatically.
        </p>
      </section>
    );
  }

  // Count statuses for summary
  const consensusCount = claim_comparisons.filter(c => c.status === 'consensus').length;
  const disputedCount = claim_comparisons.filter(c => c.status === 'disputed').length;

  return (
    <section
      aria-label="Cross-Source Claim Intelligence"
      className="mb-8 p-6 bg-white dark:bg-gray-900 rounded-xl border border-purple-200 dark:border-purple-500/30 shadow-sm"
    >
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-3 mb-5">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="w-2 h-2 rounded-full bg-purple-600 dark:bg-purple-400" aria-hidden="true" />
            <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">
              Cross-Source Intelligence — Consensus & Conflict
            </h2>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 font-mono">
            {claim_comparisons.length} discrete factual claims analyzed
            {consensusCount > 0 && ` · ${consensusCount} consensus`}
            {disputedCount > 0 && ` · ${disputedCount} disputed`}
          </p>
        </div>
        <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-purple-50 text-purple-700 dark:bg-purple-500/10 dark:text-purple-300 border border-purple-200 dark:border-purple-500/20 uppercase tracking-wide">
          Multi-Source Matrix
        </span>
      </div>

      {/* ── Claims List ── */}
      <div className="space-y-4">
        {claim_comparisons.map((item, i) => (
          <div
            key={i}
            className="p-4 rounded-lg bg-gray-50 dark:bg-gray-850 border border-gray-200 dark:border-gray-800"
          >
            <div className="flex items-start justify-between gap-3 mb-3">
              <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100 leading-snug flex-1">
                {item.claim}
              </h3>
              <div className="shrink-0">
                <ClaimStatusBadge status={item.status} />
              </div>
            </div>

            {/* Reporting Outlets */}
            <div className="space-y-2 pt-2 border-t border-gray-200 dark:border-gray-800">
              {item.sources.map((src, s) => (
                <div key={s} className="text-xs flex items-start gap-2.5">
                  <span className="font-bold text-gray-800 dark:text-gray-200 shrink-0 w-28 truncate pt-0.5">
                    {src.source_name}:
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-gray-600 dark:text-gray-400 leading-relaxed">
                      {src.position}
                    </p>
                    {src.article_ids && src.article_ids.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {src.article_ids.map(aId => {
                          const article = articleById.get(aId);
                          return article ? (
                            <a
                              key={aId}
                              href={article.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[10px] text-indigo-600 dark:text-indigo-400 hover:underline font-mono truncate max-w-xs"
                            >
                              ↗ {article.title}
                            </a>
                          ) : (
                            <span key={aId} className="text-[10px] text-gray-400 font-mono">
                              Article #{aId}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
