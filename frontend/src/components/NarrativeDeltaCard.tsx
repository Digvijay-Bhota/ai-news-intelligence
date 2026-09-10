/**
 * NarrativeDeltaCard — Phase 10: Narrative Evolution UX
 *
 * Visualizes the semantic narrative evolution between Event Brief versions.
 * Displays newly confirmed facts, shifted claims, retractions, unchanged core, and open questions.
 */

import React from 'react';
import { NarrativeDelta, NarrativeDeltaMetadata, Article } from '../types';

interface NarrativeDeltaCardProps {
  narrative_delta: NarrativeDelta | null;
  narrative_delta_metadata: NarrativeDeltaMetadata | null;
  brief_version?: number;
  articles?: Article[];
}

function ChangeTypeBadge({ type }: { type: string }) {
  const norm = type.toLowerCase();
  let classes = 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300 border-blue-200 dark:border-blue-500/20';
  if (norm === 'contradicted' || norm === 'retracted') {
    classes = 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300 border-rose-200 dark:border-rose-500/20';
  } else if (norm === 'expanded') {
    classes = 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300 border-emerald-200 dark:border-emerald-500/20';
  } else if (norm === 'uncertain') {
    classes = 'bg-purple-50 text-purple-700 dark:bg-purple-500/10 dark:text-purple-300 border-purple-200 dark:border-purple-500/20';
  }
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border ${classes}`}>
      {type}
    </span>
  );
}

export function NarrativeDeltaCard({
  narrative_delta,
  narrative_delta_metadata,
  brief_version = 1,
  articles = [],
}: NarrativeDeltaCardProps) {
  // Article lookup map for citation links
  const articleById = new Map<number, Article>();
  for (const a of articles) {
    articleById.set(a.id, a);
  }

  // ── Baseline State (Version 1) ─────────────────────────────
  if (!narrative_delta) {
    if (brief_version <= 1) {
      return (
        <section
          aria-label="Narrative Evolution — Baseline"
          className="mb-8 p-6 bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-sm"
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-400" aria-hidden="true" />
              <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Narrative Evolution</h2>
            </div>
            <span className="text-[10px] px-2 py-0.5 rounded-full font-mono font-semibold bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400 border border-gray-200 dark:border-gray-700 uppercase">
              Baseline Brief (v1)
            </span>
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
            This event is currently at its initial intelligence baseline (Version 1). Semantic narrative evolution tracking (newly confirmed facts, shifted claims, and retractions) will automatically activate when incoming reporting triggers Version 2.
          </p>
        </section>
      );
    }

    return null;
  }

  const prevV = narrative_delta.previous_version;
  const currV = narrative_delta.current_version;

  return (
    <section
      aria-label="Narrative Evolution"
      className="mb-8 p-6 bg-white dark:bg-gray-900 rounded-xl border border-indigo-200 dark:border-indigo-500/30 shadow-sm"
    >
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="w-2 h-2 rounded-full bg-indigo-600 dark:bg-indigo-400" aria-hidden="true" />
            <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">
              Narrative Evolution — What Shifted
            </h2>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 font-mono">
            Semantic diff tracking story development from Version {prevV} to Version {currV}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-md bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-500/20">
            v{prevV} → v{currV}
          </span>
        </div>
      </div>

      {/* ── Summary ── */}
      <div className="mb-6 p-4 rounded-lg bg-indigo-50/50 dark:bg-indigo-950/20 border border-indigo-100 dark:border-indigo-900/30">
        <h3 className="text-xs font-bold text-indigo-900 dark:text-indigo-300 uppercase tracking-wider mb-1.5">
          Story Evolution Summary
        </h3>
        <p className="text-sm text-gray-800 dark:text-gray-200 leading-relaxed font-medium">
          {narrative_delta.summary}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        {/* ── Newly Confirmed Facts ── */}
        {narrative_delta.newly_confirmed.length > 0 && (
          <div className="p-4 rounded-lg bg-emerald-50/40 dark:bg-emerald-950/10 border border-emerald-200/60 dark:border-emerald-900/20">
            <h3 className="text-xs font-bold text-emerald-800 dark:text-emerald-300 uppercase tracking-wider mb-3 flex items-center gap-1.5">
              <span className="text-emerald-500">✓</span> Newly Confirmed Facts ({narrative_delta.newly_confirmed.length})
            </h3>
            <ul className="space-y-3">
              {narrative_delta.newly_confirmed.map((fact, i) => (
                <li key={i} className="text-xs text-gray-800 dark:text-gray-200">
                  <p className="leading-relaxed font-medium">{fact.statement}</p>
                  {fact.source_references && fact.source_references.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {fact.source_references.map(id => {
                        const a = articleById.get(id);
                        return a ? (
                          <a
                            key={id}
                            href={a.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center text-[10px] font-mono text-emerald-700 dark:text-emerald-400 hover:underline bg-emerald-100/60 dark:bg-emerald-900/30 px-1.5 py-0.5 rounded"
                          >
                            Evidence: {a.source}
                          </a>
                        ) : (
                          <span key={id} className="text-[10px] font-mono text-gray-500">
                            Article #{id}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ── What Shifted / Changed Claims ── */}
        {narrative_delta.changed_claims.length > 0 && (
          <div className="p-4 rounded-lg bg-amber-50/40 dark:bg-amber-950/10 border border-amber-200/60 dark:border-amber-900/20">
            <h3 className="text-xs font-bold text-amber-800 dark:text-amber-300 uppercase tracking-wider mb-3 flex items-center gap-1.5">
              <span className="text-amber-500">⇄</span> What Shifted / Evolved ({narrative_delta.changed_claims.length})
            </h3>
            <ul className="space-y-3">
              {narrative_delta.changed_claims.map((claim, i) => (
                <li key={i} className="text-xs text-gray-800 dark:text-gray-200 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <ChangeTypeBadge type={claim.change_type} />
                  </div>
                  <div className="pl-2 border-l-2 border-amber-300 dark:border-amber-600/40 space-y-1">
                    <p className="text-gray-500 dark:text-gray-400 text-[11px] line-through">
                      Previously: {claim.previous_statement}
                    </p>
                    <p className="font-semibold text-gray-900 dark:text-gray-100">
                      Now: {claim.current_statement}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* ── Removed or No Longer Supported ── */}
      {narrative_delta.removed_or_no_longer_supported.length > 0 && (
        <div className="mb-6 p-4 rounded-lg bg-gray-50 dark:bg-gray-800/40 border border-gray-200 dark:border-gray-700">
          <h3 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
            Prior Claims No Longer Supported
          </h3>
          <ul className="space-y-1.5">
            {narrative_delta.removed_or_no_longer_supported.map((item, i) => (
              <li key={i} className="text-xs text-gray-600 dark:text-gray-300 flex items-start gap-2">
                <span className="text-rose-400 font-mono shrink-0">✕</span>
                <span>{item.statement}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Unchanged Core Facts ── */}
      {narrative_delta.unchanged_core.length > 0 && (
        <div className="mb-6">
          <h3 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2.5">
            Unchanged Story Core (Consistent Across Versions)
          </h3>
          <div className="flex flex-wrap gap-2">
            {narrative_delta.unchanged_core.map((core, i) => (
              <div
                key={i}
                className="px-3 py-1.5 rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-xs text-gray-700 dark:text-gray-300"
              >
                {core}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Open Questions ── */}
      {narrative_delta.open_questions.length > 0 && (
        <div>
          <h3 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
            Open Questions in Latest Reporting
          </h3>
          <ul className="space-y-1.5">
            {narrative_delta.open_questions.map((q, i) => (
              <li key={i} className="text-xs text-gray-600 dark:text-gray-300 flex items-start gap-2">
                <span className="text-indigo-400 font-mono shrink-0">?</span>
                <span>{q}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
