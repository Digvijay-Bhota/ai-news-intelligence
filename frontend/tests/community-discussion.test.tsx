import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommunityDiscussion } from '../src/components/CommunityDiscussion';
import '@testing-library/jest-dom';

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
      const replyElement = screen.getByText('This is a test reply').closest('.p-2.border');
      expect(replyElement).not.toHaveTextContent('Reply');
    });
  });

});
