/**
 *
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Feed } from '../src/components/Feed';
import { ArticleCard } from '../src/components/ArticleCard';
import * as api from '../src/lib/api';

vi.mock('../src/lib/api', () => ({
  fetchFeed: vi.fn(),
}));

const mockArticle = {
  id: 1,
  external_id: 'ext-1',
  title: 'Test Article Title',
  summary: 'Test summary content',
  url: 'https://example.com',
  source: 'Test Source',
  published_at: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
  category: null,
  topics: ['AI', 'Tech'],
  events: ['Launch'],
};

describe('ArticleCard', () => {
  it('renders title, source, summary, and external link', () => {
    render(<ArticleCard article={mockArticle} />);

    expect(screen.getByText('Test Source')).toBeDefined();
    expect(screen.getByText('Test Article Title')).toBeDefined();
    expect(screen.getByText('Test summary content')).toBeDefined();

    const link = screen.getByRole('link', { name: /Read full article:/ });
    expect(link).toHaveProperty('href', 'https://example.com/');
  });

  it('renders topic and event badges', () => {
    render(<ArticleCard article={mockArticle} />);
    expect(screen.getByText('AI')).toBeDefined();
    expect(screen.getByText('Tech')).toBeDefined();
    expect(screen.getByText('Launch')).toBeDefined();
  });
});

describe('Feed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('feed loads articles', async () => {
    vi.mocked(api.fetchFeed).mockResolvedValueOnce({
      success: true,
      data: {
        meta: { limit: 20, offset: 0, total: 1 },
        items: [mockArticle],
      }
    });

    render(<Feed />);

    // Starts in loading state
    expect(document.querySelector('.animate-pulse')).toBeDefined();

    await waitFor(() => {
      expect(screen.getByText('Test Article Title')).toBeDefined();
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

    render(<Feed />);

    await waitFor(() => {
      expect(screen.getByText('No articles found')).toBeDefined();
    });
  });

  it('error state is shown on failure', async () => {
    vi.mocked(api.fetchFeed).mockRejectedValueOnce(new Error('Network failure'));

    render(<Feed />);

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

    render(<Feed />);

    await waitFor(() => {
      expect(screen.getByText('Test Article Title')).toBeDefined();
    });

    const loadMoreBtn = screen.getByRole('button', { name: /Load more articles/i });
    fireEvent.click(loadMoreBtn);

    await waitFor(() => {
      expect(screen.getByText('Test Article Title')).toBeDefined();
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

    render(<Feed />);

    await waitFor(() => {
      expect(screen.getByText('Test Article Title')).toBeDefined();
    });

    // total is 1, we fetched 1, so load more should not be present
    expect(screen.queryByRole('button', { name: /Load more articles/i })).toBeNull();
  });
});
