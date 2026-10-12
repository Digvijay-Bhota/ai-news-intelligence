/**
 * Daily AI Briefing — selection rules, view-model mapping, request limits.
 * All API responses are mocked; no network, model, or production access.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  loadDailyBriefing,
  preselectCandidates,
  selectStories,
  toBriefingStory,
  titlesOverlap,
  MAX_DETAIL_REQUESTS,
  MAX_STORIES,
} from '../src/lib/dailyBriefing';
import { NOW, summary, detail, listResponse } from './fixtures/dailyBriefing';

const HOUR = 3600;

function mockFetchFor(list: ReturnType<typeof listResponse>, details: Record<string, unknown>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/events?') || url === '/api/events') {
      return new Response(JSON.stringify(list), { status: 200 });
    }
    const hash = url.replace('/api/events/', '');
    const body = details[hash];
    if (body instanceof Error) return new Response('fail', { status: 500 });
    if (!body) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('preselectCandidates', () => {
  it('keeps priority order and caps detail candidates at eight', () => {
    const items = Array.from({ length: 12 }, (_, i) => summary(`e${i + 1}`));
    const picked = preselectCandidates(items, NOW);
    expect(picked).toHaveLength(MAX_DETAIL_REQUESTS);
    expect(picked.map(p => p.hash)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8']);
  });

  it('excludes stale events by freshness and by last activity age', () => {
    const items = [
      summary('stale1', { freshness: 'stale' }),
      summary('old', { freshness: 'active', last_published_at: NOW - 49 * HOUR }),
      summary('noactivity', { freshness: 'active', last_published_at: null }),
      summary('fresh'),
    ];
    expect(preselectCandidates(items, NOW).map(p => p.hash)).toEqual(['fresh']);
  });

  it('skips near-duplicate headlines before spending a detail request', () => {
    const items = [
      summary('a', { title: 'OpenAI releases GPT-6 reasoning model to developers' }),
      summary('b', { title: 'OpenAI releases GPT-6 reasoning model to all developers today' }),
      summary('c', { title: 'EU finalizes AI Act enforcement guidance' }),
    ];
    expect(preselectCandidates(items, NOW).map(p => p.hash)).toEqual(['a', 'c']);
  });
});

describe('titlesOverlap', () => {
  it('does not merge distinct stories that share a company name', () => {
    expect(titlesOverlap('Nvidia unveils Blackwell Ultra GPUs', 'Nvidia faces antitrust probe in China')).toBe(false);
  });
});

describe('selectStories', () => {
  it('selects up to five eligible stories in priority order', () => {
    const details = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'].map(h => detail(h).data);
    const selected = selectStories(details, NOW);
    expect(selected).toHaveLength(MAX_STORIES);
    expect(selected.map(s => s.event.hash)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
  });

  it('excludes stories without a completed brief', () => {
    const details = [
      detail('gen', { brief: null, brief_metadata: { ...detail('x').data.brief_metadata!, status: 'generating' } }).data,
      detail('failed', { brief: null, brief_metadata: { ...detail('x').data.brief_metadata!, status: 'failed' } }).data,
      detail('none', { brief: null, brief_metadata: null }).data,
      detail('emptysummary', { brief: { ...detail('x').data.brief!, summary: '   ' } }).data,
      detail('ok').data,
    ];
    expect(selectStories(details, NOW).map(s => s.event.hash)).toEqual(['ok']);
  });

  it('excludes stale details even if the list considered them active', () => {
    const details = [detail('old', {}, { freshness: 'stale', last_published_at: NOW - 60 * HOUR }).data, detail('ok').data];
    expect(selectStories(details, NOW).map(s => s.event.hash)).toEqual(['ok']);
  });

  it('avoids duplicate coverage built from the same articles', () => {
    const first = detail('e1').data;
    const echo = detail('e2', { articles: first.articles }).data;
    const distinct = detail('e3').data;
    expect(selectStories([first, echo, distinct], NOW).map(s => s.event.hash)).toEqual(['e1', 'e3']);
  });

  it('returns only the stories that qualify (no padding)', () => {
    const details = [detail('e1').data, detail('e2', { brief: null, brief_metadata: null }).data];
    expect(selectStories(details, NOW)).toHaveLength(1);
  });
});

describe('toBriefingStory', () => {
  it('maps grounded fields and prefers the narrative delta for "what changed"', () => {
    const d = detail('e1', {
      narrative_delta: {
        previous_version: 1, current_version: 2, summary: 'Regulators confirmed the timeline.',
        newly_confirmed: [], changed_claims: [], removed_or_no_longer_supported: [], unchanged_core: [], open_questions: [],
      },
    }).data;
    const story = toBriefingStory(d);
    expect(story.summary).toBe('Grounded summary for e1.');
    expect(story.whyItMatters).toBe('Significance of e1.');
    expect(story.change).toEqual({ label: 'What changed', text: 'Regulators confirmed the timeline.' });
    expect(story.uncertainty).toBe('Open question for e1.');
    expect(story.entities).toEqual([{ name: 'Org e1', type: 'organization' }]);
    expect(story.sourceCount).toBe(3);
    expect(story.citationCount).toBe(1);
  });

  it('falls back to a key development, labelled honestly, when no delta exists', () => {
    expect(toBriefingStory(detail('e1').data).change).toEqual({ label: 'Key development', text: 'First development for e1.' });
  });

  it('omits missing optional fields rather than inventing text', () => {
    const d = detail('e1', {
      brief: { summary: 'Only a summary.', why_it_matters: ' ', key_developments: [], key_entities: [], uncertainties: [''], source_references: [] },
      intelligence: { topic_count: 0, unique_topics: [], days_active: null, coverage_density: null, top_source: null },
    }).data;
    const story = toBriefingStory(d);
    expect(story.whyItMatters).toBeNull();
    expect(story.change).toBeNull();
    expect(story.uncertainty).toBeNull();
    expect(story.entities).toEqual([]);
    expect(story.topics).toEqual([]);
    expect(story.citationCount).toBe(0);
  });

  it('does not count citations to articles that are not in the event', () => {
    const d = detail('e1').data;
    d.brief!.source_references = [{ article_id: 999999, claim_context: 'Unknown article.' }];
    expect(toBriefingStory(d).citationCount).toBe(0);
  });
});

describe('loadDailyBriefing — requests', () => {
  it('makes one list request and at most eight GET detail requests, with no brief generation', async () => {
    const items = Array.from({ length: 15 }, (_, i) => summary(`e${i + 1}`));
    const details = Object.fromEntries(items.map(i => [i.hash, detail(i.hash)]));
    const fetchMock = mockFetchFor(listResponse(items), details);
    vi.stubGlobal('fetch', fetchMock);

    const result = await loadDailyBriefing({ nowSeconds: NOW });

    const urls = fetchMock.mock.calls.map(c => String(c[0]));
    const inits = fetchMock.mock.calls.map(c => (c as unknown[])[1] as RequestInit | undefined);
    expect(urls.filter(u => u.startsWith('/api/events?'))).toEqual(['/api/events?sort=priority']);
    expect(urls.filter(u => /^\/api\/events\/[^/?]+$/.test(u))).toHaveLength(MAX_DETAIL_REQUESTS);
    expect(urls).toHaveLength(1 + MAX_DETAIL_REQUESTS);
    // Zero model calls: no brief/generation endpoints and no non-GET methods.
    expect(urls.some(u => /brief|generate|gemini|model/i.test(u))).toBe(false);
    expect(inits.every(i => !i?.method || i.method === 'GET')).toBe(true);
    expect(result.stories).toHaveLength(MAX_STORIES);
  });

  it('fetches detail data in parallel', async () => {
    const items = ['e1', 'e2', 'e3'].map(h => summary(h));
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchDetail = vi.fn(async (hash: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return detail(hash);
    });
    await loadDailyBriefing({ nowSeconds: NOW, fetchList: async () => listResponse(items), fetchDetail });
    expect(maxInFlight).toBe(3);
  });

  it('skips a story whose detail request fails without affecting others', async () => {
    const items = ['e1', 'e2', 'e3'].map(h => summary(h));
    vi.stubGlobal('fetch', mockFetchFor(listResponse(items), { e1: detail('e1'), e2: new Error('boom'), e3: detail('e3') }));
    const result = await loadDailyBriefing({ nowSeconds: NOW });
    expect(result.stories.map(s => s.hash)).toEqual(['e1', 'e3']);
    expect(result.failedDetails).toBe(1);
  });

  it('throws when the list request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    await expect(loadDailyBriefing({ nowSeconds: NOW })).rejects.toThrow();
  });

  it('throws when every detail request fails', async () => {
    const items = ['e1', 'e2'].map(h => summary(h));
    vi.stubGlobal('fetch', mockFetchFor(listResponse(items), { e1: new Error('x'), e2: new Error('y') }));
    await expect(loadDailyBriefing({ nowSeconds: NOW })).rejects.toThrow('Story details could not be loaded.');
  });

  it('returns an empty briefing without detail requests when nothing is recent', async () => {
    const items = [summary('old', { freshness: 'stale', last_published_at: NOW - 72 * HOUR })];
    const fetchMock = mockFetchFor(listResponse(items), {});
    vi.stubGlobal('fetch', fetchMock);
    const result = await loadDailyBriefing({ nowSeconds: NOW });
    expect(result.stories).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
