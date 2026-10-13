/**
 * Events page: a failed events request shows the error state, and a later
 * successful request (e.g. after a filter change) replaces it with the events.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import EventsDashboard from '../src/app/events/page';
import * as api from '../src/lib/api';
import type { EventSummary } from '../src/types';

vi.mock('../src/lib/api', () => ({
  fetchActiveEvents: vi.fn(),
}));

let mockSearchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/events',
  useSearchParams: () => mockSearchParams,
}));

vi.mock('../src/components/FollowButton', () => ({ FollowButton: () => null }));

const ERROR_TEXT = 'Failed to load events';

function event(title: string): EventSummary {
  return {
    hash: `hash-${title}`,
    title,
    description: null,
    severity: 'high',
    started_at: null,
    article_count: 3,
    last_published_at: null,
    freshness: 'active',
  };
}

function eventsResponse(titles: string[]) {
  return {
    success: true,
    data: {
      items: titles.map(event),
      summary: { total: titles.length, developing: 0, active: titles.length, stale: 0 },
    },
  };
}

const unsuccessful = { success: false, data: { items: [], summary: { total: 0, developing: 0, active: 0, stale: 0 } } };

async function changeFilters(rerender: (ui: React.ReactElement) => void, query: string, calls: number) {
  mockSearchParams = new URLSearchParams(query);
  rerender(<EventsDashboard />);
  await waitFor(() => expect(api.fetchActiveEvents).toHaveBeenCalledTimes(calls));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSearchParams = new URLSearchParams();
  // Preferences are optional for this page; an unavailable endpoint is ignored.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Events page loading errors', () => {
  it('shows the error state when the events request throws', async () => {
    vi.mocked(api.fetchActiveEvents).mockRejectedValue(new Error('network down'));

    render(<EventsDashboard />);

    expect(await screen.findByText(ERROR_TEXT)).toBeInTheDocument();
  });

  it('shows the error state when the events response is unsuccessful', async () => {
    vi.mocked(api.fetchActiveEvents).mockResolvedValue(unsuccessful);

    render(<EventsDashboard />);

    expect(await screen.findByText(ERROR_TEXT)).toBeInTheDocument();
  });

  it('clears the error when a later request succeeds', async () => {
    vi.mocked(api.fetchActiveEvents)
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(eventsResponse(['Chip export rules tighten']));

    const { rerender } = render(<EventsDashboard />);
    expect(await screen.findByText(ERROR_TEXT)).toBeInTheDocument();

    await changeFilters(rerender, 'severity=high', 2);

    expect(await screen.findByText('Chip export rules tighten')).toBeInTheDocument();
    expect(screen.queryByText(ERROR_TEXT)).not.toBeInTheDocument();
    expect(screen.getByText('Total Events')).toBeInTheDocument();
  });

  it('clears the error from an unsuccessful response when a later request succeeds', async () => {
    vi.mocked(api.fetchActiveEvents)
      .mockResolvedValueOnce(unsuccessful)
      .mockResolvedValueOnce(eventsResponse(['Chip export rules tighten']));

    const { rerender } = render(<EventsDashboard />);
    expect(await screen.findByText(ERROR_TEXT)).toBeInTheDocument();

    await changeFilters(rerender, 'freshness=developing', 2);

    expect(await screen.findByText('Chip export rules tighten')).toBeInTheDocument();
    expect(screen.queryByText(ERROR_TEXT)).not.toBeInTheDocument();
  });

  it('keeps the error state when a later request also fails', async () => {
    vi.mocked(api.fetchActiveEvents)
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(unsuccessful);

    const { rerender } = render(<EventsDashboard />);
    expect(await screen.findByText(ERROR_TEXT)).toBeInTheDocument();

    await changeFilters(rerender, 'severity=high', 2);

    expect(await screen.findByText(ERROR_TEXT)).toBeInTheDocument();
  });
});

describe('Events page successful loading', () => {
  it('shows events and summary, and refetches with the new filters', async () => {
    vi.mocked(api.fetchActiveEvents)
      .mockResolvedValueOnce(eventsResponse(['Chip export rules tighten', 'Model weights leak']))
      .mockResolvedValueOnce(eventsResponse(['Datacenter outage']));

    const { rerender } = render(<EventsDashboard />);

    expect(await screen.findByText('Chip export rules tighten')).toBeInTheDocument();
    expect(screen.getByText('Model weights leak')).toBeInTheDocument();
    expect(screen.getByText('Total Events')).toBeInTheDocument();
    expect(api.fetchActiveEvents).toHaveBeenCalledTimes(1);
    expect(api.fetchActiveEvents).toHaveBeenLastCalledWith({
      freshness: undefined, severity: undefined, min_articles: undefined, sort: undefined,
    });

    await changeFilters(rerender, 'severity=critical&min_articles=5&sort=recent', 2);

    expect(await screen.findByText('Datacenter outage')).toBeInTheDocument();
    expect(screen.queryByText('Chip export rules tighten')).not.toBeInTheDocument();
    expect(screen.queryByText(ERROR_TEXT)).not.toBeInTheDocument();
    expect(api.fetchActiveEvents).toHaveBeenLastCalledWith({
      freshness: undefined, severity: 'critical', min_articles: 5, sort: 'recent',
    });
  });
});
