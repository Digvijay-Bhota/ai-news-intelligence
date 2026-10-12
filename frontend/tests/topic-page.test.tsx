/**
 * Topic page: the feed is requested once per topic and filter set, not again
 * when the page merely re-renders with the same topic.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import TopicPage from '../src/app/topics/[slug]/page';
import { UserArticlesProvider } from '../src/lib/userArticlesContext';
import * as api from '../src/lib/api';

vi.mock('../src/lib/api', () => ({
  fetchFeed: vi.fn(),
  fetchTopics: vi.fn(),
}));

let mockSearchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/topics/ai',
  useSearchParams: () => mockSearchParams,
}));

vi.mock('../src/components/FollowButton', () => ({ FollowButton: () => null }));

const TOPICS = [
  { id: 1, name: 'Artificial Intelligence', slug: 'ai', description: '', active: 1 },
  { id: 2, name: 'Robotics', slug: 'robotics', description: '', active: 1 },
];

/** One story per requested topic, titled after it. */
function storyFor(topics: string[] | undefined) {
  const slug = topics?.[0] ?? 'all';
  return {
    id: slug === 'ai' ? 1 : 2,
    external_id: `ext-${slug}`,
    title: `${slug} story`,
    summary: null,
    url: `https://news.example.test/${slug}`,
    source: 'TechCrunch',
    published_at: null,
    category: null,
    topics: [],
    events: [],
  };
}

const params = (slug: string) => Promise.resolve({ slug });
const page = (p: Promise<{ slug: string }>) => (
  <UserArticlesProvider>
    <TopicPage params={p} />
  </UserArticlesProvider>
);

/** fetchFeed(limit, offset, q, topic, source_id, topics, sourceNames, signal) */
const feedCall = (q: string | undefined, topics: string[]) =>
  [20, 0, q, undefined, undefined, topics, undefined, expect.any(AbortSignal)];

async function renderTopic(slug: string) {
  const p = params(slug);
  const view = render(page(p));
  await waitFor(() => expect(screen.getByText(`${slug} story`)).toBeInTheDocument());
  return { ...view, params: p };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockSearchParams = new URLSearchParams();
  vi.mocked(api.fetchTopics).mockResolvedValue({ success: true, data: TOPICS });
  vi.mocked(api.fetchFeed).mockImplementation(async (_limit, _offset, _q, _topic, _source, topics) => ({
    success: true,
    data: { meta: { limit: 20, offset: 0, total: 1 }, items: [storyFor(topics)] },
  }));
});

describe('Topic page feed requests', () => {
  it('requests the topic feed once with the topic override', async () => {
    await renderTopic('ai');

    expect(screen.getByRole('heading', { name: 'Artificial Intelligence' })).toBeInTheDocument();
    expect(api.fetchFeed).toHaveBeenCalledTimes(1);
    expect(api.fetchFeed).toHaveBeenLastCalledWith(...feedCall(undefined, ['ai']));
  });

  it('does not refetch when the page re-renders with the same topic', async () => {
    const { rerender, params: p } = await renderTopic('ai');

    rerender(page(p));
    rerender(page(p));

    expect(screen.getByText('ai story')).toBeInTheDocument();
    expect(api.fetchFeed).toHaveBeenCalledTimes(1);
  });

  it('adds no requests after StrictMode setup when the page re-renders', async () => {
    const p = params('ai');
    const strict = () => <React.StrictMode>{page(p)}</React.StrictMode>;
    const { rerender } = render(strict());
    await waitFor(() => expect(screen.getByText('ai story')).toBeInTheDocument());
    // StrictMode runs the feed effect twice on mount (the first request is
    // aborted); that setup is expected. Later same-topic renders add nothing.
    const setupCalls = vi.mocked(api.fetchFeed).mock.calls.length;
    expect(vi.mocked(api.fetchFeed).mock.calls.every(call => call[5]?.[0] === 'ai')).toBe(true);

    rerender(strict());
    rerender(strict());

    expect(screen.getByText('ai story')).toBeInTheDocument();
    expect(api.fetchFeed).toHaveBeenCalledTimes(setupCalls);
  });

  it('does not refetch when new params for the same topic reload the topic details', async () => {
    const { rerender } = await renderTopic('ai');

    rerender(page(params('ai')));
    // The page reloads its topic details for the new params object.
    await waitFor(() => expect(api.fetchTopics).toHaveBeenCalledTimes(2));
    await act(async () => {});

    expect(screen.getByRole('heading', { name: 'Artificial Intelligence' })).toBeInTheDocument();
    expect(screen.getByText('ai story')).toBeInTheDocument();
    expect(api.fetchFeed).toHaveBeenCalledTimes(1);
  });

  it('requests the new topic feed when the slug changes', async () => {
    const { rerender } = await renderTopic('ai');

    rerender(page(params('robotics')));

    await waitFor(() => expect(screen.getByText('robotics story')).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Robotics' })).toBeInTheDocument();
    expect(screen.queryByText('ai story')).not.toBeInTheDocument();
    expect(api.fetchFeed).toHaveBeenCalledTimes(2);
    expect(api.fetchFeed).toHaveBeenLastCalledWith(...feedCall(undefined, ['robotics']));
  });

  it('still refetches with the topic override when a URL filter changes', async () => {
    const { rerender, params: p } = await renderTopic('ai');

    mockSearchParams = new URLSearchParams('q=chips');
    rerender(page(p));

    await waitFor(() => expect(api.fetchFeed).toHaveBeenCalledTimes(2));
    expect(api.fetchFeed).toHaveBeenLastCalledWith(...feedCall('chips', ['ai']));
    await waitFor(() => expect(screen.getByText('ai story')).toBeInTheDocument());
  });
});
