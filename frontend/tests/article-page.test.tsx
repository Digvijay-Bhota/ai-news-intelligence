/**
 * Article page: the Key Entities section shows the article-detail API's
 * extracted_entities labels. The backend binding is mocked with the Worker's
 * { success, data } article-detail body; no network or production access.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { env } from 'cloudflare:workers';
import ArticlePage from '../src/app/article/[id]/page';

vi.mock('cloudflare:workers', () => ({ env: { HMAC_SECRET: undefined, BACKEND_API: undefined } }));
vi.mock('../src/components/FollowButton', () => ({ FollowButton: () => null }));

const IMAGE_URL = 'https://platform.theverge.com/uploads/photo.jpg';

/** GET /api/v1/articles/:id data as the Worker returns it (image fields included). */
function articleDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    external_id: 'ext-1',
    title: 'Chip export rules tightened',
    summary: 'Summary of the story.',
    cleaned_text: 'Cleaned article text.',
    url: 'https://news.example.test/1',
    source: 'The Verge',
    published_at: 1760000000,
    topics: [{ name: 'OpenAI', slug: 'openai' }],
    events: [{ event_hash: 'evt-1', title: 'Export rules', description: 'New limits.', severity: 'warning', started_at: 1760000000 }],
    extracted_entities: ['OpenAI', 'GPU export rules'],
    image_url: IMAGE_URL,
    image_credit: 'Verge Photo Desk',
    ...overrides,
  };
}

const backendFetch = vi.fn();

async function renderArticle(data: Record<string, unknown>) {
  backendFetch.mockResolvedValue(new Response(JSON.stringify({ success: true, data }), { status: 200 }));
  return render(await ArticlePage({ params: Promise.resolve({ id: '1' }) }));
}

function keyEntitiesSection(): HTMLElement | null {
  return screen.queryByRole('heading', { name: 'Key Entities' })?.closest('section') ?? null;
}

function requireKeyEntitiesSection(): HTMLElement {
  const section = keyEntitiesSection();
  if (!section) throw new Error('Key Entities section is not rendered');
  return section;
}

beforeEach(() => {
  backendFetch.mockReset();
  (env as unknown as Record<string, unknown>).HMAC_SECRET = 'test-secret-key-32-bytes-long!!';
  (env as unknown as Record<string, unknown>).BACKEND_API = { fetch: backendFetch };
});

describe('Article page Key Entities', () => {
  it('lists the extracted entity labels', async () => {
    await renderArticle(articleDetail());

    const section = requireKeyEntitiesSection();
    expect(within(section).getByText('OpenAI')).toBeInTheDocument();
    expect(within(section).getByText('GPU export rules')).toBeInTheDocument();
    // The other sidebar sections are unchanged.
    expect(screen.getByRole('link', { name: 'OpenAI' })).toHaveAttribute('href', '/topics/openai');
    expect(screen.getByRole('heading', { name: 'Event Timeline' })).toBeInTheDocument();
  });

  it('omits the section when there are no labels', async () => {
    await renderArticle(articleDetail({ extracted_entities: [] }));

    expect(keyEntitiesSection()).toBeNull();
    expect(screen.getByRole('heading', { name: 'Chip export rules tightened' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'OpenAI' })).toBeInTheDocument();
  });

  it('omits the section when the field is missing', async () => {
    const data = articleDetail();
    delete data.extracted_entities;
    await renderArticle(data);

    expect(keyEntitiesSection()).toBeNull();
    expect(screen.getByRole('heading', { name: 'Chip export rules tightened' })).toBeInTheDocument();
  });

  it('does not render the article image metadata', async () => {
    const { container } = await renderArticle(articleDetail());

    expect(container.innerHTML).not.toContain(IMAGE_URL);
    expect(screen.queryByText('Verge Photo Desk')).not.toBeInTheDocument();
  });
});
