/**
 * Events page: a failed events request shows the error state, and a later
 * successful request (e.g. after a filter change) replaces it with the events.
 * Responses for superseded filters never replace the current results, and a
 * failed current request does not leave the previous summary on screen.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, within } from '@testing-library/react';
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

type EventsResult = Awaited<ReturnType<typeof api.fetchActiveEvents>>;

/** A request the test settles explicitly, to control response order. */
function deferred() {
  let resolve: (value: EventsResult) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<EventsResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The AbortSignal passed to the nth fetchActiveEvents call. */
function signalOf(call: number) {
  return vi.mocked(api.fetchActiveEvents).mock.calls[call][1];
}

type Deferred = ReturnType<typeof deferred>;

/** The Total Events figure in the summary HUD, or null when the HUD is hidden. */
function hudTotal() {
  return screen.queryByText('Total Events')?.nextElementSibling?.textContent ?? null;
}

const unsuccessful = { success: false, data: { items: [], summary: { total: 0, developing: 0, active: 0, stale: 0 } } };

/** The two ways a request fails: it throws, or the API reports no success. */
const failures: [string, (request: Deferred) => void][] = [
  ['throws', request => request.reject(new Error('network down'))],
  ['is unsuccessful', request => request.resolve(unsuccessful)],
];

async function changeFilters(rerender: (ui: React.ReactElement) => void, query: string, calls: number) {
  mockSearchParams = new URLSearchParams(query);
  rerender(<EventsDashboard />);
  await waitFor(() => expect(api.fetchActiveEvents).toHaveBeenCalledTimes(calls));
}

beforeEach(() => {
  vi.resetAllMocks();
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
    }, expect.any(AbortSignal));

    await changeFilters(rerender, 'severity=critical&min_articles=5&sort=recent', 2);

    expect(await screen.findByText('Datacenter outage')).toBeInTheDocument();
    expect(screen.queryByText('Chip export rules tighten')).not.toBeInTheDocument();
    expect(screen.queryByText(ERROR_TEXT)).not.toBeInTheDocument();
    expect(api.fetchActiveEvents).toHaveBeenLastCalledWith({
      freshness: undefined, severity: 'critical', min_articles: 5, sort: 'recent',
    }, expect.any(AbortSignal));
  });
});

describe('Events page superseded requests', () => {
  it('keeps the newer results when an older request finishes last', async () => {
    const older = deferred();
    vi.mocked(api.fetchActiveEvents)
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce(eventsResponse(['Datacenter outage']));

    const { rerender } = render(<EventsDashboard />);
    await changeFilters(rerender, 'severity=critical', 2);
    expect(await screen.findByText('Datacenter outage')).toBeInTheDocument();

    await act(async () => older.resolve(eventsResponse(['Chip export rules tighten'])));

    expect(screen.getByText('Datacenter outage')).toBeInTheDocument();
    expect(screen.queryByText('Chip export rules tighten')).not.toBeInTheDocument();
    expect(signalOf(0)?.aborted).toBe(true);
    expect(signalOf(1)?.aborted).toBe(false);
  });

  it('ignores an older request that fails after newer results are shown', async () => {
    const older = deferred();
    vi.mocked(api.fetchActiveEvents)
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce(eventsResponse(['Datacenter outage']));

    const { rerender } = render(<EventsDashboard />);
    await changeFilters(rerender, 'severity=critical', 2);
    expect(await screen.findByText('Datacenter outage')).toBeInTheDocument();

    await act(async () => older.reject(new Error('network down')));

    expect(screen.getByText('Datacenter outage')).toBeInTheDocument();
    expect(screen.queryByText(ERROR_TEXT)).not.toBeInTheDocument();
  });

  it('does not show an older response while the newer request is still loading', async () => {
    const older = deferred();
    const newer = deferred();
    vi.mocked(api.fetchActiveEvents)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    const { rerender } = render(<EventsDashboard />);
    await changeFilters(rerender, 'sort=recent', 2);

    await act(async () => older.resolve(eventsResponse(['Chip export rules tighten'])));
    expect(screen.queryByText('Chip export rules tighten')).not.toBeInTheDocument();
    expect(screen.queryByText('No Events Found')).not.toBeInTheDocument();

    await act(async () => newer.resolve(eventsResponse(['Datacenter outage'])));
    expect(screen.getByText('Datacenter outage')).toBeInTheDocument();
    expect(screen.queryByText('Chip export rules tighten')).not.toBeInTheDocument();
  });

  it('aborts the in-flight request when the page unmounts', async () => {
    vi.mocked(api.fetchActiveEvents).mockReturnValueOnce(deferred().promise);

    const { unmount } = render(<EventsDashboard />);
    await waitFor(() => expect(api.fetchActiveEvents).toHaveBeenCalledTimes(1));
    unmount();

    expect(signalOf(0)?.aborted).toBe(true);
  });
});

describe('Events page failure after loaded results', () => {
  it.each(failures)('hides the previous summary when the filtered request %s', async (_label, fail) => {
    const failing = deferred();
    vi.mocked(api.fetchActiveEvents)
      .mockResolvedValueOnce(eventsResponse(['Chip export rules tighten', 'Model weights leak']))
      .mockReturnValueOnce(failing.promise);

    const { rerender } = render(<EventsDashboard />);
    expect(await screen.findByText('Chip export rules tighten')).toBeInTheDocument();
    expect(hudTotal()).toBe('2');

    await changeFilters(rerender, 'severity=critical', 2);
    await act(async () => fail(failing));

    expect(screen.getByText(ERROR_TEXT)).toBeInTheDocument();
    expect(hudTotal()).toBeNull();
    expect(screen.queryByText('Chip export rules tighten')).not.toBeInTheDocument();
  });

  it('drops the previous interest matches when the filtered request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { preferred_topics: ['chip'], preferred_sources: [] } }),
    }));
    vi.mocked(api.fetchActiveEvents)
      .mockResolvedValueOnce(eventsResponse(['Chip export rules tighten', 'Model weights leak']))
      .mockRejectedValueOnce(new Error('network down'));

    const { rerender } = render(<EventsDashboard />);
    const matches = await screen.findByRole('button', { name: /Matched My Interests/ });
    await waitFor(() => expect(within(matches).getByText('1')).toBeInTheDocument());

    await changeFilters(rerender, 'severity=critical', 2);

    expect(await screen.findByText(ERROR_TEXT)).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /Matched My Interests/ })).queryByText('1')).not.toBeInTheDocument();
  });

  it('shows the new summary when a request after the failure succeeds', async () => {
    vi.mocked(api.fetchActiveEvents)
      .mockResolvedValueOnce(eventsResponse(['Chip export rules tighten', 'Model weights leak']))
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(eventsResponse(['Datacenter outage']));

    const { rerender } = render(<EventsDashboard />);
    expect(await screen.findByText('Chip export rules tighten')).toBeInTheDocument();

    await changeFilters(rerender, 'severity=critical', 2);
    expect(await screen.findByText(ERROR_TEXT)).toBeInTheDocument();

    await changeFilters(rerender, 'severity=high', 3);

    expect(await screen.findByText('Datacenter outage')).toBeInTheDocument();
    expect(hudTotal()).toBe('1');
    expect(screen.queryByText(ERROR_TEXT)).not.toBeInTheDocument();
  });

  it.each(failures)('keeps the newer summary when a superseded request %s', async (_label, fail) => {
    const older = deferred();
    vi.mocked(api.fetchActiveEvents)
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce(eventsResponse(['Datacenter outage']));

    const { rerender } = render(<EventsDashboard />);
    await changeFilters(rerender, 'severity=critical', 2);
    expect(await screen.findByText('Datacenter outage')).toBeInTheDocument();
    expect(hudTotal()).toBe('1');

    await act(async () => fail(older));

    expect(screen.getByText('Datacenter outage')).toBeInTheDocument();
    expect(hudTotal()).toBe('1');
    expect(screen.queryByText(ERROR_TEXT)).not.toBeInTheDocument();
  });
});
