/**
 * Event detail page — renders the stored brief (why it matters, key
 * developments, uncertainties, citations) without duplicating the summary.
 * The backend binding is mocked; no network, model, or production access.
 */
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';
import { env } from 'cloudflare:workers';
import EventPage from '../src/app/events/[hash]/page';
import { detail } from './fixtures/dailyBriefing';

vi.mock('cloudflare:workers', () => ({ env: { HMAC_SECRET: undefined, BACKEND_API: undefined } }));
vi.mock('../src/components/FollowButton', () => ({ FollowButton: () => null }));
vi.mock('../src/components/CommunityDiscussion', () => ({ CommunityDiscussion: () => null }));

const backendFetch = vi.fn();

async function renderPage(body: unknown) {
  backendFetch.mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
  const ui = await EventPage({ params: Promise.resolve({ hash: 'e1' }) });
  return render(ui);
}

beforeEach(() => {
  backendFetch.mockReset();
  (env as unknown as Record<string, unknown>).HMAC_SECRET = 'test-secret-key-32-bytes-long!!';
  (env as unknown as Record<string, unknown>).BACKEND_API = { fetch: backendFetch };
});

afterEach(() => cleanup());

describe('Event detail page — stored brief', () => {
  it('renders why it matters, key developments, uncertainties, and linked citations', async () => {
    const body = detail('e1');
    body.data.brief!.key_developments = ['First development for e1.', 'Second development for e1.'];
    await renderPage(body);

    const brief = screen.getByRole('region', { name: 'AI Intelligence Brief' });
    expect(within(brief).getByText('Significance of e1.')).toBeInTheDocument();
    expect(within(brief).getByText('First development for e1.')).toBeInTheDocument();
    expect(within(brief).getByText('Second development for e1.')).toBeInTheDocument();
    expect(within(brief).getByText('Open question for e1.')).toBeInTheDocument();
    expect(within(brief).getByText('Org e1')).toBeInTheDocument();

    const citation = within(brief).getByRole('link', { name: 'e1 article 1' });
    expect(citation).toHaveAttribute('href', 'https://news.example/e1/1');
    expect(document.getElementById('evidence-sources')).toContainElement(citation);
    expect(document.getElementById('source-material')).toBeInTheDocument();
  });

  it('shows the summary once (in the header), not again inside the brief card', async () => {
    await renderPage(detail('e1'));
    expect(screen.getAllByText('Grounded summary for e1.')).toHaveLength(1);
    expect(screen.queryByText('What is Happening')).not.toBeInTheDocument();
  });

  it('keeps story evolution, source perspectives, source material, and sharing', async () => {
    const body = detail('e1', {
      narrative_delta: {
        previous_version: 1, current_version: 2, summary: 'Evolved.',
        newly_confirmed: [{ statement: 'A newly confirmed fact.', source_references: [11] }],
        changed_claims: [], removed_or_no_longer_supported: [], unchanged_core: [], open_questions: [],
      },
      claim_comparisons: [{ claim: 'Launch date is set.', status: 'consensus', sources: [{ source_id: 1, source_name: 'Source 1', position: 'Confirms.', article_ids: [11] }] }],
    });
    await renderPage(body);
    expect(screen.getByText('Story Evolution')).toBeInTheDocument();
    expect(screen.getByText('A newly confirmed fact.')).toBeInTheDocument();
    expect(screen.getByText('Source Perspectives')).toBeInTheDocument();
    expect(screen.getByText('Launch date is set.')).toBeInTheDocument();
    expect(screen.getByText('Source Material')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Share story:/ })).toBeInTheDocument();
  });

  it('shows the existing not-yet-generated state without inventing a brief', async () => {
    await renderPage(detail('e1', { brief: null, brief_metadata: null }));
    expect(screen.getByText('Not yet generated')).toBeInTheDocument();
    expect(screen.queryByText('Why It Matters')).not.toBeInTheDocument();
  });

  it('only reads the stored event (one GET, no brief generation)', async () => {
    await renderPage(detail('e1'));
    expect(backendFetch).toHaveBeenCalledTimes(1);
    const req = backendFetch.mock.calls[0][0] as Request;
    expect(req.method).toBe('GET');
    expect(new URL(req.url).pathname).toBe('/api/v1/events/e1');
  });
});
