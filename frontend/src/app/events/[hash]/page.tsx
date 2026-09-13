import React from 'react';
import Link from 'next/link';
import { env } from 'cloudflare:workers';
import { generateHmac } from '../../../utils/hmac';
import { EventDetailResponse } from '../../../types';
import { ErrorState } from '../../../components/ErrorState';
import { EmptyState } from '../../../components/EmptyState';
import { FollowButton } from '../../../components/FollowButton';
import { Kicker, EditorialHeading, SectionLabel, Metadata, Divider } from '../../../components/Foundations';
import { SourceChip } from '../../../components/Editorial/SourceChip';

export const runtime = 'edge';

async function getEvent(hash: string): Promise<EventDetailResponse> {
  const secret = env.HMAC_SECRET;
  if (!secret) throw new Error('Missing HMAC_SECRET');

  const backend = env.BACKEND_API;
  if (!backend || typeof backend.fetch !== 'function') throw new Error('Missing BACKEND_API binding');

  const ts = Math.floor(Date.now() / 1000);
  const nonce = `nonce-${ts}-${Math.random().toString(36).substring(2, 9)}`;
  const fullPath = `/api/v1/events/${hash}`;

  const hmacPayload = { method: 'GET', path: fullPath, timestamp: ts, nonce, body: '' };
  const signature = await generateHmac(hmacPayload, secret);

  const backendReq = new Request(`http://backend${fullPath}`, {
    method: 'GET',
    headers: { 'X-HMAC-Signature': signature, 'X-Nonce': nonce, 'X-Timestamp': String(ts) },
  });

  const res = await backend.fetch(backendReq);
  if (!res.ok) throw new Error(`Backend error: ${res.status}`);
  return res.json();
}

export default async function EventPage({ params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  let eventDetail: EventDetailResponse | undefined;

  try {
    eventDetail = await getEvent(hash);
  } catch (error) {
    return <div className="max-w-5xl mx-auto py-8"><ErrorState message="Failed to load the event." /></div>;
  }

  if (!eventDetail?.success || !eventDetail.data) {
    return (
      <div className="max-w-5xl mx-auto py-8 text-center">
        <EmptyState title="Event Not Found" message="This event does not exist or has been removed." />
        <Link href="/" className="mt-4 inline-block text-accent hover:underline">Return to Feed</Link>
      </div>
    );
  }

  const { event, coverage, intelligence, articles, brief, narrative_delta, claim_comparisons, change_summary } = eventDetail.data;

  const firstReport = coverage?.first_published_at ? new Date(coverage.first_published_at * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Unknown';
  const lastReport = event.last_published_at ? new Date(event.last_published_at * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Unknown';

  return (
    <article className="max-w-4xl mx-auto pb-24">
      {/* Navigation & Utilities */}
      <div className="flex items-center justify-between mb-8">
        <Link href="/" className="font-sans text-sm font-bold text-slate hover:text-charcoal uppercase tracking-widest flex items-center gap-1.5 transition-colors">
          &larr; Front Page
        </Link>
        <FollowButton targetType="event" targetId={event.hash} compact={false} />
      </div>

      {/* 1. WHAT ACTUALLY HAPPENED? (Hero) */}
      <header className="mb-12">
        <Kicker type={event.freshness === 'developing' ? 'developing' : event.severity === 'critical' ? 'breaking' : 'default'}>
          {event.freshness === 'developing' ? 'Developing Story' : event.severity === 'critical' ? 'Critical Update' : 'Active Intelligence'}
        </Kicker>

        <EditorialHeading level={1} className="mb-6">{event.title}</EditorialHeading>

        {brief ? (
          <div className="font-serif text-xl leading-relaxed text-charcoal/90 mb-8 max-w-3xl">
            {brief.summary}
          </div>
        ) : (
          event.description && (
            <div className="font-serif text-xl leading-relaxed text-charcoal/90 mb-8 max-w-3xl">
              {event.description}
            </div>
          )
        )}

        <Metadata className="mt-6 border-y border-divider py-4">
          <span className="font-bold">{coverage.total_articles} Articles</span>
          <span className="text-divider px-1">|</span>
          <span className="font-bold">{coverage.total_sources} Sources</span>
          <span className="text-divider px-1">|</span>
          <span>Started: {firstReport}</span>
          <span className="text-divider px-1">|</span>
          <span>Latest: {lastReport}</span>
        </Metadata>

        {intelligence && (intelligence.unique_topics?.length > 0 || intelligence.top_source || intelligence.days_active !== null || intelligence.coverage_density !== null) && (
          <div className="mt-6 font-sans text-sm">
            <SectionLabel className="border-none text-xs pb-2 !mb-2 text-slate">Coverage Intelligence</SectionLabel>
            <div className="flex flex-col gap-2.5">
              {intelligence.unique_topics && intelligence.unique_topics.length > 0 && (
                <div className="flex flex-wrap gap-2 items-center">
                  <span className="text-slate uppercase tracking-wider text-[11px] font-bold w-28 shrink-0">Topics:</span>
                  {intelligence.unique_topics.map((t: string) => (
                    <Link key={t} href={`/topics?q=${encodeURIComponent(t)}`} className="text-charcoal hover:text-accent underline decoration-divider hover:decoration-accent transition-colors">
                      {t}
                    </Link>
                  ))}
                </div>
              )}
              {intelligence.top_source && (
                <div className="flex items-center gap-2">
                  <span className="text-slate uppercase tracking-wider text-[11px] font-bold w-28 shrink-0">Top Source:</span>
                  <SourceChip name={intelligence.top_source} />
                </div>
              )}
              {intelligence.days_active !== null && intelligence.days_active !== undefined && (
                <div className="flex items-center gap-2">
                  <span className="text-slate uppercase tracking-wider text-[11px] font-bold w-28 shrink-0">Duration:</span>
                  <span className="text-charcoal font-medium text-xs">ACTIVE FOR {intelligence.days_active} {intelligence.days_active === 1 ? 'DAY' : 'DAYS'}</span>
                </div>
              )}
              {intelligence.coverage_density !== null && intelligence.coverage_density !== undefined && (
                <div className="flex items-center gap-2">
                  <span className="text-slate uppercase tracking-wider text-[11px] font-bold w-28 shrink-0">Density:</span>
                  <span className="text-charcoal font-medium text-xs">{intelligence.coverage_density.toFixed(1)} articles/day</span>
                </div>
              )}
            </div>
          </div>
        )}
      </header>

      {/* 2. WHAT CHANGED? */}
      {change_summary && change_summary.has_changed && (
        <section className="mb-16 bg-accent/5 dark:bg-accent/10 border-l-4 border-accent p-6 rounded-r-sm">
          <SectionLabel className="border-none pb-0 mb-3 text-accent">Since Last Visit</SectionLabel>
          <div className="font-sans text-charcoal flex flex-col gap-2 text-sm">
            {change_summary.article_delta > 0 && <div><span className="font-bold">+{change_summary.article_delta}</span> new articles published.</div>}
            {change_summary.source_delta > 0 && <div><span className="font-bold">+{change_summary.source_delta}</span> new sources joined coverage.</div>}
            <div className="mt-2 text-xs text-slate">These changes are reflected in the intelligence below.</div>
          </div>
        </section>
      )}

      {/* 3. HOW DID IT EVOLVE? */}
      {narrative_delta && (narrative_delta.changed_claims.length > 0 || narrative_delta.newly_confirmed.length > 0) && (
        <section className="mb-16">
          <SectionLabel>Story Evolution</SectionLabel>
          <div className="pl-4 border-l-2 border-divider space-y-6 mt-6">
            {narrative_delta.changed_claims.map((claim, idx) => (
              <div key={idx} className="relative">
                <div className="absolute -left-[21px] top-1.5 w-2.5 h-2.5 bg-paper border-2 border-developing rounded-full" />
                <Kicker type="developing">Claim {claim.change_type}</Kicker>
                <div className="font-serif text-lg text-charcoal mb-2">{claim.current_statement}</div>
                <div className="font-sans text-sm text-slate line-through">Previously: {claim.previous_statement}</div>
              </div>
            ))}
            {narrative_delta.newly_confirmed.map((fact, idx) => (
              <div key={`fact-${idx}`} className="relative">
                <div className="absolute -left-[21px] top-1.5 w-2.5 h-2.5 bg-paper border-2 border-positive rounded-full" />
                <Kicker type="positive">Newly Confirmed Fact</Kicker>
                <div className="font-serif text-lg text-charcoal">{fact.statement}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 4. WHAT ARE THE SOURCES SAYING? */}
      {claim_comparisons && claim_comparisons.length > 0 && (
        <section className="mb-16">
          <SectionLabel>Source Perspectives</SectionLabel>
          <div className="grid gap-6 mt-6">
            {claim_comparisons.map((comp, idx) => (
              <div key={idx} className="border border-divider p-5 bg-surface">
                <Kicker type={
                  comp.status === 'consensus' ? 'positive' :
                  comp.status === 'disputed' ? 'breaking' :
                  comp.status === 'evolving' ? 'developing' : 'default'
                }>{comp.status}</Kicker>
                <h3 className="font-serif text-lg font-bold text-charcoal mb-4">{comp.claim}</h3>
                <div className="space-y-3">
                  {comp.sources.map((src, sIdx) => (
                    <div key={sIdx} className="flex flex-col sm:flex-row sm:items-baseline gap-2 sm:gap-4 p-3 bg-paper border border-divider/50 rounded-sm">
                      <div className="sm:w-1/3 shrink-0"><SourceChip name={src.source_name} /></div>
                      <div className="sm:w-2/3 font-sans text-sm text-charcoal">{src.position}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 5. SOURCE MATERIAL */}
      <section className="mb-16">
        <SectionLabel>Source Material</SectionLabel>
        <div className="mt-6 flex flex-col gap-4">
          {articles.map(article => (
            <a key={article.id} href={article.url} target="_blank" rel="noopener noreferrer" className="group flex flex-col sm:flex-row sm:items-center gap-3 p-4 bg-surface border border-divider hover:border-slate transition-colors">
              <div className="sm:w-1/4 shrink-0">
                <SourceChip name={article.source} url={article.url} />
              </div>
              <div className="sm:w-3/4">
                <h4 className="font-sans font-bold text-charcoal group-hover:text-accent transition-colors mb-1">{article.title}</h4>
                {article.published_at && (
                  <time className="font-sans text-xs text-slate">
                    {new Date(article.published_at * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                  </time>
                )}
              </div>
            </a>
          ))}
        </div>
      </section>

      {/* PHASE 12E: Community Foundation */}
      <section className="mt-24 pt-8 border-t border-divider">
        <SectionLabel className="border-none text-muted">Discussion</SectionLabel>
        <div className="font-sans text-sm text-slate italic p-6 bg-surface border border-divider border-dashed text-center">
          Community insights and discussion threads will appear here.
        </div>
      </section>
    </article>
  );
}
