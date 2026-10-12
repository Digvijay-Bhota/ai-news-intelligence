/** Mocked API data for Daily AI Briefing tests. No real API responses. */
import type { EventDetailResponse, EventSummary } from '../../src/types';

export const NOW = 1_760_000_000;
const HOUR = 3600;

const TITLES = [
  'OpenAI ships GPT-6 reasoning model',
  'EU finalizes AI Act enforcement guidance',
  'Nvidia unveils Blackwell Ultra accelerators',
  'Anthropic expands Claude enterprise availability',
  'Google DeepMind publishes protein folding update',
  'Meta open-sources Llama 5 weights',
  'Apple delays on-device assistant overhaul',
  'Microsoft signs nuclear power agreement for datacenters',
  'Mistral raises funding round in Paris',
  'TSMC reports record quarterly chip revenue',
  'US Commerce tightens accelerator export rules',
  'Stability AI restructures leadership team',
  'Amazon launches custom Trainium3 instances',
  'Samsung begins HBM4 memory production',
  'xAI opens Memphis supercomputer cluster',
];

function titleFor(hash: string): string {
  const n = Number(hash.replace(/\D/g, ''));
  return Number.isFinite(n) && n > 0 ? TITLES[(n - 1) % TITLES.length] : `Standalone report ${hash}`;
}

export function summary(hash: string, overrides: Partial<EventSummary> = {}): EventSummary {
  return {
    hash,
    title: titleFor(hash),
    description: null,
    severity: 'medium',
    started_at: NOW - 10 * HOUR,
    article_count: 4,
    last_published_at: NOW - 2 * HOUR,
    freshness: 'developing',
    ...overrides,
  };
}

type Detail = EventDetailResponse['data'];

export function detail(hash: string, overrides: Partial<Detail> = {}, eventOverrides: Partial<Detail['event']> = {}): EventDetailResponse {
  const base = summary(hash);
  const articles = [1, 2, 3].map(n => ({
    id: Number(`${hash.replace(/\D/g, '') || 9}${n}`),
    external_id: `${hash}-${n}`,
    title: `${hash} article ${n}`,
    summary: null,
    url: `https://news.example/${hash}/${n}`,
    source: `Source ${n}`,
    published_at: NOW - n * HOUR,
    category: null,
    topics: [],
    events: [],
  }));
  return {
    success: true,
    data: {
      event: {
        hash,
        title: base.title,
        description: null,
        severity: 'medium',
        started_at: base.started_at,
        last_published_at: base.last_published_at,
        freshness: 'developing',
        ...eventOverrides,
      },
      coverage: {
        total_articles: 3,
        total_sources: 3,
        first_published_at: NOW - 3 * HOUR,
        last_published_at: base.last_published_at,
        sources: [],
      },
      intelligence: { topic_count: 1, unique_topics: ['Machine Learning'], days_active: 1, coverage_density: 3, top_source: 'Source 1' },
      brief: {
        summary: `Grounded summary for ${hash}.`,
        why_it_matters: `Significance of ${hash}.`,
        key_developments: [`First development for ${hash}.`],
        key_entities: [{ name: `Org ${hash}`, type: 'organization', relevance: 'Primary actor.' }],
        uncertainties: [`Open question for ${hash}.`],
        source_references: [{ article_id: articles[0].id, claim_context: 'Context.' }],
      },
      brief_metadata: {
        version: 2,
        status: 'completed',
        generated_at: NOW - HOUR,
        model: 'stored-model',
        article_fingerprint: 'fp',
        article_count: 3,
        source_count: 3,
        is_stale: false,
        unincorporated_article_count: 0,
      },
      narrative_delta: null,
      change_summary: null,
      articles,
      ...overrides,
    },
  };
}

export function listResponse(items: EventSummary[]) {
  return { success: true, data: { items, summary: { total: items.length, developing: items.length, active: 0, stale: 0 } } };
}
