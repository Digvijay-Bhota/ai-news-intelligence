/**
 * FollowsProvider: cached follows from localStorage, then a BFF sync.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { FollowsProvider } from '../src/lib/followsContext';
import { FollowButton } from '../src/components/FollowButton';

const CACHE_KEY = 'ai_news_follows';

function renderButtons() {
  render(
    <FollowsProvider>
      <FollowButton targetType="topic" targetId="robotics" />
      <FollowButton targetType="topic" targetId="agents" />
    </FollowsProvider>
  );
}

describe('FollowsProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(CACHE_KEY, JSON.stringify([{ target_type: 'topic', target_id: 'robotics' }]));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('restores cached follows, then replaces them with the BFF list', async () => {
    let respond: (response: Response) => void = () => {};
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => new Promise<Response>(resolve => { respond = resolve; })
    );

    renderButtons();

    // Usable from the cache before the BFF answers.
    expect(screen.getByRole('button', { name: 'Unfollow robotics' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Follow agents' })).toBeEnabled();
    expect(fetchSpy).toHaveBeenCalledWith('/api/follows');

    const synced = [{ id: 'f1', target_type: 'topic', target_id: 'agents' }];
    respond(new Response(JSON.stringify({ success: true, data: synced }), { status: 200 }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Unfollow agents' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Follow robotics' })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(CACHE_KEY)!)).toEqual(synced);
  });

  it('keeps the cached follows when the BFF sync fails', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }));

    renderButtons();

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/follows'));
    await fetchSpy.mock.results[0].value;
    expect(screen.getByRole('button', { name: 'Unfollow robotics' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Follow agents' })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(CACHE_KEY)!)).toEqual([{ target_type: 'topic', target_id: 'robotics' }]);
  });
});
