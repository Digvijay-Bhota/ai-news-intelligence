/**
 *
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Feed } from '../src/components/Feed';
import { FeedFilters } from '../src/components/FeedFilters';
import { ArticleCard } from '../src/components/ArticleCard';
import * as api from '../src/lib/api';
import { UserArticlesProvider } from '../src/lib/userArticlesContext';

vi.mock('../src/lib/api', () => ({
  fetchFeed: vi.fn(),
  fetchTopics: vi.fn().mockResolvedValue({ success: true, data: [] }),
  fetchSources: vi.fn().mockResolvedValue({ success: true, data: [] })
}));

let mockSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn()
  }),
  usePathname: () => '/',
  useSearchParams: () => mockSearchParams
}));

const mockArticle = {
  id: 1,
  external_id: 'ext-123',
  title: 'Test AI Article',
  summary: 'This is a test summary about AI.',
  url: 'https://example.com/test-ai',
  source: 'TechCrunch',
  published_at: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
  category: null,
  topics: ['Artificial Intelligence'],
  events: [{ title: 'AI Update', hash: 'event123' }],
};

const renderWithProvider = (ui: React.ReactElement) => {
  return render(<UserArticlesProvider>{ui}</UserArticlesProvider>);
};

describe('ArticleCard', () => {
  it('renders title, source, summary, and external link', () => {
    renderWithProvider(<ArticleCard article={mockArticle} />);

    expect(screen.getByText('TechCrunch')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Test AI Article' })).toHaveAttribute('href', '/article/1');
    expect(screen.getByText('This is a test summary about AI.')).toBeInTheDocument();

    const link = screen.getByRole('link', { name: 'Read full article at source: Test AI Article' });
    expect(link).toHaveAttribute('href', 'https://example.com/test-ai');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  // Since the 9817006 redesign the card shows linked event badges (at most
  // two) and no topic badges.
  it('renders linked event badges, at most two', () => {
    renderWithProvider(<ArticleCard article={{
      ...mockArticle,
      events: [...mockArticle.events, { title: 'Second Event', hash: 'event456' }, { title: 'Third Event', hash: 'event789' }],
    }} />);
    expect(screen.getByRole('link', { name: 'AI Update' })).toHaveAttribute('href', '/events/event123');
    expect(screen.getByRole('link', { name: 'Second Event' })).toHaveAttribute('href', '/events/event456');
    expect(screen.queryByRole('link', { name: 'Third Event' })).not.toBeInTheDocument();
  });

  // Article images stay hidden until image-use rights are established, even
  // though /api/feed items can carry validated image_url/image_credit fields.
  it('does not render article image metadata', () => {
    const imageUrl = 'https://platform.theverge.com/uploads/2026/10/photo.jpg';
    const withImage = { ...mockArticle, image_url: imageUrl, image_credit: 'Verge Photo Desk' };
    const { container } = renderWithProvider(<ArticleCard article={withImage} />);

    expect(screen.getByRole('link', { name: 'Test AI Article' })).toBeInTheDocument();
    expect(container.querySelector(`img[src="${imageUrl}"]`)).toBeNull();
    expect(container.innerHTML).not.toContain(imageUrl);
    expect(screen.queryByText('Verge Photo Desk')).not.toBeInTheDocument();
  });
});

const feedPage = (items: typeof mockArticle[], total = items.length) => ({
  success: true as const,
  data: { meta: { limit: 20, offset: 0, total }, items },
});

describe('Feed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockSearchParams = new URLSearchParams();
  });

  it('reloads the first page when the URL filters change', async () => {
    vi.mocked(api.fetchFeed)
      .mockResolvedValueOnce(feedPage([mockArticle]))
      .mockResolvedValueOnce(feedPage([{ ...mockArticle, id: 2, title: 'Robotics Article' }]));

    const { rerender } = renderWithProvider(<Feed />);
    await waitFor(() => expect(screen.getByText('Test AI Article')).toBeInTheDocument());

    mockSearchParams = new URLSearchParams('q=robotics');
    rerender(<UserArticlesProvider><Feed /></UserArticlesProvider>);

    // The loading state replaces the previous results right away.
    expect(document.querySelector('.animate-pulse')).not.toBeNull();
    expect(screen.queryByText('Test AI Article')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Robotics Article')).toBeInTheDocument());
    expect(api.fetchFeed).toHaveBeenCalledTimes(2);
    expect(api.fetchFeed).toHaveBeenLastCalledWith(
      20, 0, 'robotics', undefined, undefined, undefined, undefined, expect.any(AbortSignal)
    );
  });

  it('retries after an error', async () => {
    vi.mocked(api.fetchFeed)
      .mockRejectedValueOnce(new Error('Network failure'))
      .mockResolvedValueOnce(feedPage([mockArticle]));

    renderWithProvider(<Feed />);
    await waitFor(() => expect(screen.getByText('Network failure')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(screen.getByText('Test AI Article')).toBeInTheDocument());
    expect(screen.queryByText('Network failure')).not.toBeInTheDocument();
    expect(api.fetchFeed).toHaveBeenCalledTimes(2);
  });

  it('restores saved and hidden articles from the previous session', async () => {
    localStorage.setItem('ai_news_saved', JSON.stringify([{ saved_id: 7, article: mockArticle }]));
    localStorage.setItem('ai_news_hidden', JSON.stringify([2]));
    vi.mocked(api.fetchFeed).mockResolvedValueOnce(
      feedPage([mockArticle, { ...mockArticle, id: 2, title: 'Previously Hidden Article' }])
    );

    renderWithProvider(<Feed />);

    await waitFor(() => expect(screen.getByText('Test AI Article')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Unsave article' })).toBeInTheDocument();
    expect(screen.queryByText('Previously Hidden Article')).not.toBeInTheDocument();
    // The restored lists are written back unchanged.
    expect(JSON.parse(localStorage.getItem('ai_news_hidden')!)).toEqual([2]);
  });

  it('feed loads articles', async () => {
    vi.mocked(api.fetchFeed).mockResolvedValueOnce({
      success: true,
      data: {
        meta: { limit: 20, offset: 0, total: 1 },
        items: [mockArticle],
      }
    });

    renderWithProvider(<Feed />);

    // Starts in loading state
    expect(document.querySelector('.animate-pulse')).not.toBeNull();

    await waitFor(() => {
      expect(screen.getByText('Test AI Article')).toBeDefined();
    });
  });

  it('empty state is shown', async () => {
    vi.mocked(api.fetchFeed).mockResolvedValueOnce({
      success: true,
      data: {
        meta: { limit: 20, offset: 0, total: 0 },
        items: [],
      }
    });

    renderWithProvider(<Feed />);

    await waitFor(() => {
      expect(screen.getByText('No articles found')).toBeDefined();
    });
  });

  it('error state is shown on failure', async () => {
    vi.mocked(api.fetchFeed).mockRejectedValueOnce(new Error('Network failure'));

    renderWithProvider(<Feed />);

    await waitFor(() => {
      expect(screen.getByText('Unable to load feed')).toBeDefined();
      expect(screen.getByText('Network failure')).toBeDefined();
    });
  });

  it('load-more behavior appends items', async () => {
    vi.mocked(api.fetchFeed)
      .mockResolvedValueOnce({
        success: true,
        data: {
          meta: { limit: 1, offset: 0, total: 2 },
          items: [mockArticle],
        }
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          meta: { limit: 1, offset: 1, total: 2 },
          items: [{ ...mockArticle, id: 2, title: 'Second Article' }],
        }
      });

    renderWithProvider(<Feed />);

    await waitFor(() => {
      expect(screen.getByText('Test AI Article')).toBeDefined();
    });

    const loadMoreBtn = screen.getByRole('button', { name: /Load more articles/i });
    fireEvent.click(loadMoreBtn);

    await waitFor(() => {
      expect(screen.getByText('Test AI Article')).toBeDefined();
      expect(screen.getByText('Second Article')).toBeDefined();
    });
  });

  it('no more pages behavior hides load more button', async () => {
    vi.mocked(api.fetchFeed).mockResolvedValueOnce({
      success: true,
      data: {
        meta: { limit: 20, offset: 0, total: 1 },
        items: [mockArticle],
      }
    });

    renderWithProvider(<Feed />);

    await waitFor(() => {
      expect(screen.getByText('Test AI Article')).toBeDefined();
    });

    expect(screen.queryByRole('button', { name: /Load more articles/i })).toBeNull();
  });
});

describe('Article Actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    // mock global fetch
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ id: 999 })
    })));
  });

  it('save and unsave flow', async () => {
    vi.mocked(api.fetchFeed).mockResolvedValueOnce({
      success: true,
      data: {
        meta: { limit: 20, offset: 0, total: 1 },
        items: [mockArticle],
      }
    });

    renderWithProvider(<Feed />);

    await waitFor(() => {
      expect(screen.getByText('Test AI Article')).toBeDefined();
    });

    const saveBtn = screen.getByRole('button', { name: 'Save article' });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/saved', expect.objectContaining({ method: 'POST' }));
    });

    // UI updates to Unsave
    expect(screen.getByRole('button', { name: 'Unsave article' })).toBeDefined();

    const unsaveBtn = screen.getByRole('button', { name: 'Unsave article' });
    fireEvent.click(unsaveBtn);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/saved/999', expect.objectContaining({ method: 'DELETE' }));
    });
  });

  it('hide flow optimistically removes article', async () => {
    vi.mocked(api.fetchFeed).mockResolvedValueOnce({
      success: true,
      data: {
        meta: { limit: 20, offset: 0, total: 1 },
        items: [mockArticle],
      }
    });

    renderWithProvider(<Feed />);

    await waitFor(() => {
      expect(screen.getByText('Test AI Article')).toBeDefined();
    });

    const hideBtn = screen.getByRole('button', { name: 'Hide article' });
    fireEvent.click(hideBtn);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/hide', expect.objectContaining({ method: 'POST' }));
    });

    // The article is hidden from feed
    await waitFor(() => {
      expect(screen.queryByText('Test AI Article')).toBeNull();
    });
  });
});

describe('Feed Filters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
  });

  it('initializes filters from URL', async () => {
    mockSearchParams.set('q', 'robotics');
    mockSearchParams.set('topic', 'ai');
    mockSearchParams.set('source_id', '1');

    vi.mocked(api.fetchFeed).mockResolvedValueOnce({
      success: true,
      data: {
        meta: { limit: 20, offset: 0, total: 1 },
        items: [mockArticle],
      }
    });

    renderWithProvider(<Feed />);

    await waitFor(() => {
      // fetchFeed(limit, offset, q, topic, source_id, topics, sourceNames, signal);
      // Feed passes its optional topic/source overrides, unset here.
      expect(api.fetchFeed).toHaveBeenCalledWith(
        20, 0, 'robotics', 'ai', '1', undefined, undefined, expect.any(AbortSignal)
      );
    });
  });

  it('renders FeedFilters with correct defaults and metadata', async () => {
    mockSearchParams.set('q', 'test-query');
    vi.mocked(api.fetchTopics).mockResolvedValueOnce({
      success: true, data: [{ id: 1, name: 'AI Topic', slug: 'ai', description: '', active: 1 }]
    });
    vi.mocked(api.fetchSources).mockResolvedValueOnce({
      success: true, data: [{ id: 1, name: 'TechCrunch', base_url: '', source_type: '', active: 1 }]
    });

    renderWithProvider(<FeedFilters />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('test-query')).toBeDefined();
      expect(screen.getByText('AI Topic')).toBeDefined();
      expect(screen.getByText('TechCrunch')).toBeDefined();
    });
  });

  it('keeps typed search text until the URL query changes, then follows the URL', async () => {
    mockSearchParams.set('q', 'first');
    const ui = () => <UserArticlesProvider><FeedFilters /></UserArticlesProvider>;
    const { rerender } = render(ui());
    const input = screen.getByLabelText('Search');
    expect(input).toHaveValue('first');

    fireEvent.change(input, { target: { value: 'first draft' } });
    rerender(ui());
    expect(input).toHaveValue('first draft');

    mockSearchParams = new URLSearchParams('q=second');
    rerender(ui());
    expect(input).toHaveValue('second');
    await waitFor(() => expect(api.fetchTopics).toHaveBeenCalled());
  });
});
