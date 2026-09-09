/**
 * EventBriefCard — Phase 9: Grounded AI Event Briefing
 *
 * Renders the AI Intelligence Brief for an event with strict provenance display.
 * Handles all lifecycle states: completed, generating, failed, unavailable, stale.
 */

import React from 'react';
import { EventBrief, EventBriefMetadata, Article } from '../types';

interface EventBriefCardProps {
  brief: EventBrief | null;
  brief_metadata: EventBriefMetadata | null;
  articles?: Article[];
}

function EntityTypeBadge({ type }: { type: string }) {
  const normalized = type.toLowerCase();
  let classes = 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border-gray-200 dark:border-gray-700';
  if (normalized === 'person') classes = 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300 border-indigo-200 dark:border-indigo-500/20';
  else if (normalized === 'organization' || normalized === 'org') classes = 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300 border-blue-200 dark:border-blue-500/20';
  else if (normalized === 'location' || normalized === 'place') classes = 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300 border-emerald-200 dark:border-emerald-500/20';
  else if (normalized === 'technology' || normalized === 'product') classes = 'bg-purple-50 text-purple-700 dark:bg-purple-500/10 dark:text-purple-300 border-purple-200 dark:border-purple-500/20';
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide border ${classes}`}>
      {type}
    </span>
  );
}

function BriefSkeleton() {
  return (
    <div className="animate-pulse space-y-4">
      <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-3/4" />
      <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-full" />
      <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-5/6" />
      <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-2/3" />
    </div>
  );
}

export function EventBriefCard({ brief, brief_metadata, articles = [] }: EventBriefCardProps) {
  const status = brief_metadata?.status ?? (brief ? 'completed' : 'unavailable');

  // Build article lookup for provenance display
  const articleById = new Map<number, Article>();
  for (const a of articles) {
    articleById.set(a.id, a);
  }

  // ── Unavailable State ──────────────────────────────────────
  if (status === 'unavailable' || (!brief && !brief_metadata)) {
    return (
      <section
        aria-label="AI Intelligence Brief"
        className="mb-8 p-6 bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-sm"
      >
        <div className="flex items-center gap-2 mb-4">
          <span className="w-2 h-2 rounded-full bg-gray-300 dark:bg-gray-600" aria-hidden="true" />
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Intelligence Brief</h2>
          <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full font-semibold bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 border border-gray-200 dark:border-gray-700 uppercase tracking-wide">
            Not yet generated
          </span>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
          The grounded intelligence brief for this event has not been synthesized yet. Briefs are generated automatically during pipeline runs when sufficient article coverage is available.
        </p>
      </section>
    );
  }

  // ── Generating State ───────────────────────────────────────
  if (status === 'generating') {
    return (
      <section
        aria-label="AI Intelligence Brief — generating"
        className="mb-8 p-6 bg-white dark:bg-gray-900 rounded-xl border border-indigo-200 dark:border-indigo-500/20 shadow-sm"
      >
        <div className="flex items-center gap-2 mb-4">
          <span className="relative flex h-2 w-2" aria-hidden="true">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500" />
          </span>
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Intelligence Brief</h2>
          <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full font-semibold bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-500/20 uppercase tracking-wide">
            Synthesizing
          </span>
        </div>
        <p className="text-sm text-indigo-700 dark:text-indigo-300 mb-4">
          Intelligence synthesis in progress — grounding claims against {brief_metadata?.article_count ?? 'available'} articles.
        </p>
        <BriefSkeleton />
      </section>
    );
  }

  // ── Failed State ───────────────────────────────────────────
  if (status === 'failed' || !brief) {
    return (
      <section
        aria-label="AI Intelligence Brief — failed"
        className="mb-8 p-6 bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-sm"
      >
        <div className="flex items-center gap-2 mb-3">
          <span className="w-2 h-2 rounded-full bg-amber-400" aria-hidden="true" />
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Intelligence Brief</h2>
          <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full font-semibold bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300 border border-amber-200 dark:border-amber-500/20 uppercase tracking-wide">
            Unavailable
          </span>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Brief generation encountered an error. The deterministic event intelligence above remains accurate and up-to-date.
        </p>
      </section>
    );
  }

  // ── Completed State ────────────────────────────────────────
  const isStale = brief_metadata?.is_stale === true;
  const unincorporatedCount = brief_metadata?.unincorporated_article_count ?? 0;

  return (
    <section
      aria-label="AI Intelligence Brief"
      className="mb-8 p-6 bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-sm"
    >
      {/* ── Header ── */}
      <div className="flex items-start gap-2 mb-5">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="w-2 h-2 rounded-full bg-indigo-500 shrink-0" aria-hidden="true" />
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Intelligence Brief</h2>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-500/20 uppercase tracking-wide">
            AI Synthesis
          </span>
        </div>
      </div>

      {/* ── Stale Notice ── */}
      {isStale && unincorporatedCount > 0 && (
        <div className="mb-4 px-4 py-2.5 rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 text-sm text-amber-800 dark:text-amber-300 flex items-center gap-2">
          <span aria-hidden="true">⚠</span>
          <span>
            Brief reflects an earlier event state — {unincorporatedCount} new article{unincorporatedCount !== 1 ? 's' : ''} not yet incorporated. A fresh synthesis will be generated in the next pipeline run.
          </span>
        </div>
      )}

      {/* ── Provenance Metadata ── */}
      <div className="mb-5 text-xs text-gray-400 dark:text-gray-500 font-mono">
        AI-synthesized from {brief_metadata?.article_count ?? brief.source_references.length} articles across{' '}
        {brief_metadata?.source_count ?? '—'} sources
        {brief_metadata?.model && ` · ${brief_metadata.model}`}
        {brief_metadata?.generated_at &&
          ` · generated ${new Date(brief_metadata.generated_at * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`}
      </div>

      {/* ── Summary ── */}
      <div className="mb-6">
        <h3 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
          What is Happening
        </h3>
        <p className="text-gray-800 dark:text-gray-200 leading-relaxed text-sm">
          {brief.summary}
        </p>
      </div>

      {/* ── Why It Matters ── */}
      <div className="mb-6">
        <h3 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
          Why It Matters
        </h3>
        <p className="text-gray-700 dark:text-gray-300 leading-relaxed text-sm italic border-l-2 border-indigo-300 dark:border-indigo-500/40 pl-3">
          {brief.why_it_matters}
        </p>
      </div>

      {/* ── Key Developments ── */}
      {brief.key_developments.length > 0 && (
        <div className="mb-6">
          <h3 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
            Key Developments
          </h3>
          <ul className="space-y-2">
            {brief.key_developments.map((dev, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-gray-800 dark:text-gray-200">
                <span className="text-indigo-400 dark:text-indigo-500 font-mono shrink-0 mt-0.5">▸</span>
                <span>{dev}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Key Entities ── */}
      {brief.key_entities.length > 0 && (
        <div className="mb-6">
          <h3 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">
            Key Entities
          </h3>
          <div className="flex flex-wrap gap-2">
            {brief.key_entities.map((entity, i) => (
              <div
                key={i}
                className="group relative inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-xs"
                title={entity.relevance}
              >
                <EntityTypeBadge type={entity.type} />
                <span className="font-semibold text-gray-900 dark:text-gray-100">{entity.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Uncertainties ── */}
      {brief.uncertainties.length > 0 && (
        <div className="mb-6">
          <h3 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
            What Remains Uncertain
          </h3>
          <div className="px-4 py-3 rounded-lg bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 space-y-1.5">
            {brief.uncertainties.map((unc, i) => (
              <p key={i} className="text-sm text-gray-600 dark:text-gray-300 flex items-start gap-2">
                <span className="text-gray-400 dark:text-gray-500 shrink-0">?</span>
                <span>{unc}</span>
              </p>
            ))}
          </div>
        </div>
      )}

      {/* ── Cited Sources ── */}
      {brief.source_references.length > 0 && (
        <div>
          <h3 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
            Evidence Sources ({brief.source_references.length})
          </h3>
          <div className="space-y-2">
            {brief.source_references.slice(0, 6).map((ref, i) => {
              const article = articleById.get(ref.article_id);
              return (
                <div key={i} className="flex items-start gap-3 text-xs">
                  <span className="text-[10px] font-mono text-gray-400 dark:text-gray-500 shrink-0 mt-0.5 w-5 text-right">
                    [{i + 1}]
                  </span>
                  <div className="min-w-0">
                    {article ? (
                      <a
                        href={article.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-indigo-600 dark:text-indigo-400 hover:underline truncate block"
                      >
                        {article.title}
                      </a>
                    ) : (
                      <span className="font-mono text-gray-500 dark:text-gray-400">
                        Article #{ref.article_id}
                      </span>
                    )}
                    <p className="text-gray-500 dark:text-gray-400 mt-0.5 leading-relaxed">
                      {ref.claim_context}
                    </p>
                  </div>
                </div>
              );
            })}
            {brief.source_references.length > 6 && (
              <p className="text-xs text-gray-400 dark:text-gray-500 font-mono pl-8">
                +{brief.source_references.length - 6} additional cited sources
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
