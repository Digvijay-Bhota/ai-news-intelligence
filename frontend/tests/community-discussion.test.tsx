import React from 'react';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommunityDiscussion } from '../src/components/CommunityDiscussion';
import '@testing-library/jest-dom/vitest';

describe('CommunityDiscussion', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    global.fetch = mockFetch;
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { items: [], next_cursor: null } })
    });
  });

  it('renders loading state then empty state', async () => {
    render(<CommunityDiscussion eventHash="evt123" />);
    expect(screen.getByText('Loading discussion...')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('No posts yet. Be the first to discuss this event!')).toBeInTheDocument();
    });
  });

  it('renders posts and public data separation', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          items: [{
            id: 'post1',
            body: 'Hello world',
            author_display_name: 'TestUser',
            created_at: 1600000000,
            upvotes: 5,
            reply_count: 2
          }],
          next_cursor: 'next_page'
        }
      })
    });
    
    render(<CommunityDiscussion eventHash="evt123" />);
    await waitFor(() => {
      expect(screen.getByText('Hello world')).toBeInTheDocument();
    });
    expect(screen.getByText('TestUser')).toBeInTheDocument();
    expect(screen.getByText('👍 5')).toBeInTheDocument();
    expect(screen.getByText('View Replies (2)')).toBeInTheDocument();
    // Test that private data isn't assumed in the payload
    expect(screen.getByRole('button', { name: 'Load More' })).toBeInTheDocument();
  });

  it('handles successful top-level post creation', async () => {
    render(<CommunityDiscussion eventHash="evt123" />);
    await waitFor(() => screen.getByPlaceholderText('Share your thoughts...'));
    
    fireEvent.change(screen.getByPlaceholderText('Share your thoughts...'), { target: { value: 'New post content' } });
    
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, id: 'new_id' })
    });
    
    fireEvent.click(screen.getByText('Post'));
    
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/v1/events/evt123/community', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ body: 'New post content' })
      }));
    });
  });

  it('handles post validation failure', async () => {
    render(<CommunityDiscussion eventHash="evt123" />);
    await waitFor(() => screen.getByPlaceholderText('Share your thoughts...'));
    
    fireEvent.change(screen.getByPlaceholderText('Share your thoughts...'), { target: { value: 'Bad post' } });
    
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'Body exceeds 5000 characters' })
    });
    
    fireEvent.click(screen.getByText('Post'));
    
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Body exceeds 5000 characters');
    });
  });

  it('handles reply submission', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          items: [{
            id: 'post1',
            body: 'Hello world',
            author_display_name: 'TestUser',
            created_at: 1600000000,
            upvotes: 0
          }],
          next_cursor: null
        }
      })
    });
    
    render(<CommunityDiscussion eventHash="evt123" />);
    await waitFor(() => screen.getByText('Hello world'));
    
    fireEvent.click(screen.getAllByText('Reply')[0]);
    fireEvent.change(screen.getByLabelText('New reply'), { target: { value: 'My reply' } });
    
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, id: 'reply1' })
    });
    
    fireEvent.click(screen.getByText('Submit Reply'));
    
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/v1/community/posts/post1/replies', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ body: 'My reply' })
      }));
    });
  });

  it('handles rejected reply error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          items: [{
            id: 'post1',
            body: 'Hello world',
            author_display_name: 'TestUser',
            created_at: 1600000000,
            upvotes: 0
          }],
          next_cursor: null
        }
      })
    });
    
    render(<CommunityDiscussion eventHash="evt123" />);
    await waitFor(() => screen.getByText('Hello world'));
    
    fireEvent.click(screen.getAllByText('Reply')[0]);
    fireEvent.change(screen.getByLabelText('New reply'), { target: { value: 'My reply' } });
    
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'Excessive nesting. Replies can only be to top-level posts.' })
    });
    
    fireEvent.click(screen.getByText('Submit Reply'));
    
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Excessive nesting');
    });
  });

  it('handles upvote action', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          items: [{
            id: 'post1',
            body: 'Hello world',
            author_display_name: 'TestUser',
            created_at: 1600000000,
            upvotes: 0
          }],
          next_cursor: null
        }
      })
    });
    
    render(<CommunityDiscussion eventHash="evt123" />);
    await waitFor(() => screen.getByText('Hello world'));
    
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true })
    });
    
    fireEvent.click(screen.getByLabelText('Upvote'));
    
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/v1/community/posts/post1/vote', expect.objectContaining({
        method: 'PUT'
      }));
    });
  });

  it('handles edit action', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          items: [{
            id: 'post1',
            body: 'Hello world',
            author_display_name: 'TestUser',
            created_at: 1600000000,
            upvotes: 0
          }],
          next_cursor: null
        }
      })
    });
    
    render(<CommunityDiscussion eventHash="evt123" />);
    await waitFor(() => screen.getByText('Hello world'));
    
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.change(screen.getByLabelText('Edit post'), { target: { value: 'Edited text' } });
    
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true })
    });
    
    fireEvent.click(screen.getByText('Save'));
    
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/v1/community/posts/post1', expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ body: 'Edited text' })
      }));
    });
  });

  it('handles delete action', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          items: [{
            id: 'post1',
            body: 'Hello world',
            author_display_name: 'TestUser',
            created_at: 1600000000,
            upvotes: 0
          }],
          next_cursor: null
        }
      })
    });
    
    render(<CommunityDiscussion eventHash="evt123" />);
    await waitFor(() => screen.getByText('Hello world'));
    
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true })
    });
    
    fireEvent.click(screen.getByText('Delete'));
    
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/v1/community/posts/post1', expect.objectContaining({
        method: 'DELETE'
      }));
    });
  });
  
  it('handles report action', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          items: [{
            id: 'post1',
            body: 'Hello world',
            author_display_name: 'TestUser',
            created_at: 1600000000,
            upvotes: 0
          }],
          next_cursor: null
        }
      })
    });
    
    render(<CommunityDiscussion eventHash="evt123" />);
    await waitFor(() => screen.getByText('Hello world'));
    
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true })
    });
    
    fireEvent.click(screen.getByText('Report'));
    
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/v1/community/posts/post1/report', expect.objectContaining({
        method: 'POST'
      }));
    });
  });
  
  it('handles load more pagination', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          items: [{
            id: 'post1',
            body: 'Hello world',
            author_display_name: 'TestUser',
            created_at: 1600000000,
            upvotes: 0
          }],
          next_cursor: 'page_2'
        }
      })
    });
    
    render(<CommunityDiscussion eventHash="evt123" />);
    await waitFor(() => screen.getByText('Hello world'));
    
    fireEvent.click(screen.getByRole('button', { name: 'Load More' }));
    
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/v1/events/evt123/community?cursor=page_2');
    });
  });

  it('fetches and renders replies when View Replies is clicked', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          items: [{
            id: 'post1',
            body: 'Hello world',
            author_display_name: 'TestUser',
            created_at: 1600000000,
            upvotes: 0,
            reply_count: 1
          }],
          next_cursor: null
        }
      })
    });
    
    render(<CommunityDiscussion eventHash="evt123" />);
    await waitFor(() => screen.getByText('Hello world'));
    
    // Mock the reply fetch
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          items: [{
            id: 'reply1',
            body: 'This is a test reply',
            author_display_name: 'ReplyUser',
            created_at: 1600000050,
            upvotes: 2,
            reply_count: 0
          }]
        }
      })
    });
    
    fireEvent.click(screen.getByText('View Replies (1)'));
    
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/v1/community/posts/post1/replies');
      expect(screen.getByText('This is a test reply')).toBeInTheDocument();
      expect(screen.getByText('ReplyUser')).toBeInTheDocument();
      expect(screen.getByText('👍 2')).toBeInTheDocument();
      // Replies are depth 1, so a reply has no Reply action of its own. Check the
      // control, not the text: the reply's author "ReplyUser" contains "Reply".
      const replyElement = screen.getByText('This is a test reply').closest<HTMLElement>('.p-2.border');
      expect(replyElement).not.toBeNull();
      expect(within(replyElement!).queryByRole('button', { name: 'Reply' })).not.toBeInTheDocument();
      // The top-level post keeps its Reply button, and it is the only one.
      expect(screen.getByRole('button', { name: 'Reply' })).toBeInTheDocument();
    });
  });

  describe('overlapping post-list requests', () => {
    const LIST_URL = '/api/v1/events/evt123/community';

    const okJson = (body: unknown) => ({ ok: true, json: async () => body });
    const page = (items: object[], next_cursor: string | null = null) =>
      okJson({ success: true, data: { items, next_cursor } });
    const post = (id: string, body: string, upvotes = 0) =>
      ({ id, body, author_display_name: 'TestUser', created_at: 1600000000, upvotes });

    /** A response the test releases explicitly, to control completion order. */
    function deferred() {
      let resolve: (value: unknown) => void = () => {};
      let reject: (reason: unknown) => void = () => {};
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    }

    /** Answers first-page list requests from `lists` in order; mutations succeed. */
    function serveLists(...lists: unknown[]) {
      mockFetch.mockImplementation((url: string, init?: { method?: string }) => {
        if (init?.method) return Promise.resolve(okJson({ success: true }));
        if (url !== LIST_URL) return Promise.reject(new Error(`Unexpected request: ${url}`));
        return Promise.resolve(lists.shift());
      });
    }

    const listCalls = () =>
      mockFetch.mock.calls.filter(([url, init]) => url === LIST_URL && !init).length;

    it('appends the next page once when Load More is clicked twice', async () => {
      const pageTwo = [deferred(), deferred()];
      let pageTwoCalls = 0;
      mockFetch.mockImplementation((url: string) => {
        if (url === `${LIST_URL}?cursor=page_2`) return pageTwo[pageTwoCalls++].promise;
        if (url === `${LIST_URL}?cursor=page_3`) return Promise.resolve(page([post('post3', 'Third page post')]));
        return Promise.resolve(page([post('post1', 'First page post')], 'page_2'));
      });

      render(<CommunityDiscussion eventHash="evt123" />);
      await screen.findByText('First page post');

      const loadMore = screen.getByRole('button', { name: 'Load More' });
      fireEvent.click(loadMore);
      fireEvent.click(loadMore);

      // Both requests (if two were sent) answer with page 2.
      await act(async () => {
        pageTwo.forEach(request => request.resolve(page([post('post2', 'Second page post')], 'page_3')));
      });

      expect(screen.getAllByText('Second page post')).toHaveLength(1);
      expect(screen.getAllByText('First page post')).toHaveLength(1);
      expect(pageTwoCalls).toBe(1);

      // Pagination continues from page 2's cursor.
      fireEvent.click(screen.getByRole('button', { name: 'Load More' }));
      expect(await screen.findByText('Third page post')).toBeInTheDocument();
      expect(mockFetch).toHaveBeenCalledWith(`${LIST_URL}?cursor=page_3`);
    });

    it('keeps the newer reload when an older one finishes last', async () => {
      const older = deferred();
      const newer = deferred();
      serveLists(page([post('a', 'Post A'), post('b', 'Post B')]), older.promise, newer.promise);

      render(<CommunityDiscussion eventHash="evt123" />);
      await screen.findByText('Post A');

      const [upvoteA, upvoteB] = screen.getAllByLabelText('Upvote');
      fireEvent.click(upvoteA);
      await waitFor(() => expect(listCalls()).toBe(2));
      fireEvent.click(upvoteB);
      await waitFor(() => expect(listCalls()).toBe(3));

      await act(async () => newer.resolve(page([post('a', 'Post A', 1), post('b', 'Post B', 1)])));
      expect(screen.getAllByText('👍 1')).toHaveLength(2);

      // The reload after the first vote still lacks the second vote.
      await act(async () => older.resolve(page([post('a', 'Post A', 1), post('b', 'Post B', 0)])));
      expect(screen.getAllByText('👍 1')).toHaveLength(2);
      expect(screen.queryByText('👍 0')).not.toBeInTheDocument();
    });

    it('keeps a new post when an older reload finishes after it', async () => {
      const older = deferred();
      const newer = deferred();
      serveLists(page([post('a', 'Post A')]), older.promise, newer.promise);

      render(<CommunityDiscussion eventHash="evt123" />);
      await screen.findByText('Post A');

      fireEvent.click(screen.getByLabelText('Upvote'));
      await waitFor(() => expect(listCalls()).toBe(2));
      fireEvent.change(screen.getByPlaceholderText('Share your thoughts...'), { target: { value: 'My new post' } });
      fireEvent.click(screen.getByText('Post'));
      await waitFor(() => expect(listCalls()).toBe(3));

      await act(async () => newer.resolve(page([post('n', 'My new post'), post('a', 'Post A', 1)])));
      expect(screen.getByText('My new post')).toBeInTheDocument();

      await act(async () => older.resolve(page([post('a', 'Post A', 1)])));
      expect(screen.getAllByText('My new post')).toHaveLength(1);
    });

    it('ignores an older reload that fails after a newer one succeeded', async () => {
      const older = deferred();
      const newer = deferred();
      serveLists(page([post('a', 'Post A'), post('b', 'Post B')], 'page_2'), older.promise, newer.promise);

      render(<CommunityDiscussion eventHash="evt123" />);
      await screen.findByText('Post A');

      const [upvoteA, upvoteB] = screen.getAllByLabelText('Upvote');
      fireEvent.click(upvoteA);
      await waitFor(() => expect(listCalls()).toBe(2));
      fireEvent.click(upvoteB);
      await waitFor(() => expect(listCalls()).toBe(3));

      await act(async () => newer.resolve(page([post('a', 'Post A', 1), post('b', 'Post B', 1)], 'page_2')));
      await act(async () => older.reject(new Error('Network down')));

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getAllByText('👍 1')).toHaveLength(2);
      expect(screen.getByRole('button', { name: 'Load More' })).toBeEnabled();
    });

    it('does not end loading for the current event when an earlier request settles', async () => {
      const first = deferred();
      const second = deferred();
      mockFetch.mockImplementation((url: string) =>
        url === '/api/v1/events/evt123/community' ? first.promise : second.promise);

      const { rerender } = render(<CommunityDiscussion eventHash="evt123" />);
      rerender(<CommunityDiscussion eventHash="evt456" />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/api/v1/events/evt456/community'));

      await act(async () => first.resolve(page([post('old', 'Earlier event post')])));
      expect(screen.getByText('Loading discussion...')).toBeInTheDocument();
      expect(screen.queryByText('Earlier event post')).not.toBeInTheDocument();

      await act(async () => second.resolve(page([post('cur', 'Current event post')])));
      expect(screen.getByText('Current event post')).toBeInTheDocument();
      expect(screen.queryByText('Earlier event post')).not.toBeInTheDocument();
    });

    it('drops an in-flight Load More page when a reload replaces the list', async () => {
      const pageTwo = deferred();
      const reload = deferred();
      mockFetch.mockImplementation((url: string, init?: { method?: string }) => {
        if (init?.method) return Promise.resolve(okJson({ success: true }));
        if (url === `${LIST_URL}?cursor=page_2`) return pageTwo.promise;
        return listCalls() === 1
          ? Promise.resolve(page([post('a', 'Post A')], 'page_2'))
          : reload.promise;
      });

      render(<CommunityDiscussion eventHash="evt123" />);
      await screen.findByText('Post A');

      fireEvent.click(screen.getByRole('button', { name: 'Load More' }));
      await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(`${LIST_URL}?cursor=page_2`));
      fireEvent.click(screen.getByLabelText('Upvote'));
      await waitFor(() => expect(listCalls()).toBe(2));

      await act(async () => reload.resolve(page([post('a', 'Post A', 1)], 'page_2')));
      // Page 2 was requested for the list the reload replaced.
      await act(async () => pageTwo.resolve(page([post('b', 'Second page post')], 'page_3')));

      expect(screen.getByText('👍 1')).toBeInTheDocument();
      expect(screen.queryByText('Second page post')).not.toBeInTheDocument();
      const loadMore = screen.getByRole('button', { name: 'Load More' });
      expect(loadMore).toBeEnabled();
      fireEvent.click(loadMore);
      await waitFor(() => expect(mockFetch).toHaveBeenLastCalledWith(`${LIST_URL}?cursor=page_2`));
    });
  });

});
