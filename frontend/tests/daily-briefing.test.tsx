/**
 * Daily AI Briefing — rendering, states, accessibility hooks, image fallback.
 * The API module is mocked; no network, model, or production access.
 */
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent, cleanup } from '@testing-library/react';
import { DailyBriefing } from '../src/components/DailyBriefing/DailyBriefing';
import { BriefingStoryCard } from '../src/components/DailyBriefing/BriefingStoryCard';
import { StoryVisual } from '../src/components/DailyBriefing/StoryVisual';
import { toBriefingStory } from '../src/lib/dailyBriefing';
import * as api from '../src/lib/api';
import { summary, detail, listResponse } from './fixtures/dailyBriefing';

vi.mock('../src/lib/api', () => ({
  fetchActiveEvents: vi.fn(),
  fetchEvent: vi.fn(),
}));

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Fixtures relative to the real clock, since the component uses Date.now(). */
function recentSummary(hash: string) {
  return summary(hash, { last_published_at: nowSeconds() - 2 * 3600 });
}
function recentDetail(hash: string, overrides = {}) {
  return detail(hash, overrides, { last_published_at: nowSeconds() - 2 * 3600 });
}

function mockBriefing(hashes: string[], detailFor: (h: string) => unknown = h => recentDetail(h)) {
  vi.mocked(api.fetchActiveEvents).mockResolvedValue(listResponse(hashes.map(recentSummary)));
  vi.mocked(api.fetchEvent).mockImplementation(async (hash: string) => {
    const d = detailFor(hash);
    if (d instanceof Error) throw d;
    return d as Awaited<ReturnType<typeof api.fetchEvent>>;
  });
}

beforeEach(() => {
  vi.mocked(api.fetchActiveEvents).mockReset();
  vi.mocked(api.fetchEvent).mockReset();
});

afterEach(() => {
  cleanup();
});

describe('DailyBriefing states', () => {
  it('shows an accessible loading skeleton while loading', () => {
    vi.mocked(api.fetchActiveEvents).mockReturnValue(new Promise(() => {}));
    render(<DailyBriefing />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveTextContent("Loading today's briefing");
    expect(screen.getByRole('heading', { level: 1, name: 'Daily AI Briefing' })).toBeInTheDocument();
  });

  it('renders five stories with a lead story and grounded sections', async () => {
    mockBriefing(['e1', 'e2', 'e3', 'e4', 'e5', 'e6']);
    render(<DailyBriefing />);

    const lead = await screen.findByRole('heading', { level: 2, name: 'OpenAI ships GPT-6 reasoning model' });
    expect(screen.getAllByRole('article')).toHaveLength(5);
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(4);
    expect(screen.getByText('5 stories')).toBeInTheDocument();
    expect(screen.queryByText(/Fewer stories are available today/)).not.toBeInTheDocument();

    const leadCard = within(lead.closest('article')!);
    expect(leadCard.getByText('Grounded summary for e1.')).toBeInTheDocument();
    expect(leadCard.getByText('Why it matters')).toBeInTheDocument();
    expect(leadCard.getByText('Significance of e1.')).toBeInTheDocument();
    expect(leadCard.getByText('Key development')).toBeInTheDocument();
    expect(leadCard.getByText("What's uncertain")).toBeInTheDocument();
    expect(leadCard.getByRole('list', { name: "Who's involved" })).toHaveTextContent('Org e1');
    expect(leadCard.getByRole('link', { name: 'OpenAI ships GPT-6 reasoning model' })).toHaveAttribute('href', '/events/e1');
    expect(leadCard.getByRole('link', { name: /3 sources and 3 articles for:/ })).toHaveAttribute('href', '/events/e1#source-material');
    expect(leadCard.getByRole('link', { name: /1 citation for:/ })).toHaveAttribute('href', '/events/e1#evidence-sources');
    expect(leadCard.getByText(/^Updated /)).toBeInTheDocument();
    expect(api.fetchActiveEvents).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.fetchEvent).mock.calls.length).toBeLessThanOrEqual(8);
  });

  it('shows partial results with an explanation when only two stories qualify', async () => {
    mockBriefing(['e1', 'e2', 'e3'], h => (h === 'e3' ? recentDetail(h, { brief: null, brief_metadata: null }) : recentDetail(h)));
    render(<DailyBriefing />);
    await screen.findByRole('heading', { level: 2 });
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(screen.getByRole('note')).toHaveTextContent('Fewer stories are available today');
    expect(within(screen.getByRole('note')).getByRole('link', { name: 'Browse all events' })).toHaveAttribute('href', '/events');
  });

  it('shows an empty state linking to the events page', async () => {
    vi.mocked(api.fetchActiveEvents).mockResolvedValue(listResponse([]));
    render(<DailyBriefing />);
    expect(await screen.findByText('No briefing stories yet today')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Browse all events' })).toHaveAttribute('href', '/events');
    expect(api.fetchEvent).not.toHaveBeenCalled();
  });

  it('shows an error with a working retry action', async () => {
    vi.mocked(api.fetchActiveEvents).mockRejectedValueOnce(new Error('network down'));
    render(<DailyBriefing />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Today's briefing couldn't load");

    mockBriefing(['e1', 'e2', 'e3']);
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'OpenAI ships GPT-6 reasoning model' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(api.fetchActiveEvents).toHaveBeenCalledTimes(2);
  });

  it('skips a story whose detail request fails and renders the rest', async () => {
    mockBriefing(['e1', 'e2', 'e3', 'e4'], h => (h === 'e2' ? new Error('detail failed') : recentDetail(h)));
    render(<DailyBriefing />);
    await screen.findByRole('heading', { level: 2 });
    const titles = screen.getAllByRole('article').map(a => within(a).getAllByRole('heading')[0].textContent);
    expect(titles).toEqual([
      'OpenAI ships GPT-6 reasoning model',
      'Nvidia unveils Blackwell Ultra accelerators',
      'Anthropic expands Claude enterprise availability',
    ]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('BriefingStoryCard', () => {
  it('omits sections whose data is missing', () => {
    const d = recentDetail('e1', {
      brief: { summary: 'Only a summary.', why_it_matters: '', key_developments: [], key_entities: [], uncertainties: [], source_references: [] },
      intelligence: { topic_count: 0, unique_topics: [], days_active: null, coverage_density: null, top_source: null },
    });
    render(<BriefingStoryCard story={toBriefingStory(d.data)} position={2} />);
    expect(screen.getByText('Only a summary.')).toBeInTheDocument();
    for (const label of ['Why it matters', 'What changed', 'Key development', "What's uncertain", "Who's involved"]) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('link', { name: /citation/ })).not.toBeInTheDocument();
  });

  it('notes when the stored summary predates the latest reports', () => {
    const d = recentDetail('e1');
    d.data.brief_metadata!.is_stale = true;
    render(<BriefingStoryCard story={toBriefingStory(d.data)} position={1} />);
    expect(screen.getByText(/written before the latest reports/)).toBeInTheDocument();
  });

  it('uses only native, labelled, keyboard-focusable controls in reading order', () => {
    render(<BriefingStoryCard story={toBriefingStory(recentDetail('e1').data)} lead position={1} />);
    const article = screen.getByRole('article');
    const focusables = Array.from(article.querySelectorAll<HTMLElement>('a, button, [tabindex]'));
    expect(focusables.every(el => el.tagName === 'A' || el.tagName === 'BUTTON')).toBe(true);
    expect(focusables.every(el => !el.hasAttribute('tabindex') || Number(el.getAttribute('tabindex')) <= 0)).toBe(true);
    expect(focusables.map(el => el.getAttribute('aria-label') ?? el.textContent)).toEqual([
      'OpenAI ships GPT-6 reasoning model',
      expect.stringMatching(/^3 sources and 3 articles for:/),
      expect.stringMatching(/^1 citation for:/),
      'Share story: OpenAI ships GPT-6 reasoning model',
      'Read the full story: OpenAI ships GPT-6 reasoning model',
    ]);
    focusables[0].focus();
    expect(document.activeElement).toBe(focusables[0]);
  });

  it('copies the story link when native sharing is unavailable', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<BriefingStoryCard story={toBriefingStory(recentDetail('e1').data)} position={1} />);
    fireEvent.click(screen.getByRole('button', { name: /Share story/ }));
    await waitFor(() => expect(screen.getByText('Link copied')).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/events/e1`);
  });

  it('declares stacked mobile and multi-column desktop layouts', async () => {
    mockBriefing(['e1', 'e2', 'e3']);
    render(<DailyBriefing />);
    const lead = (await screen.findByRole('heading', { level: 2 })).closest('article')!;
    expect(lead.className).toMatch(/\blg:grid-cols-12\b/);
    const grid = screen.getAllByRole('article')[1].parentElement!;
    expect(grid.className).toMatch(/\bgrid-cols-1\b/);
    expect(grid.className).toMatch(/\bsm:grid-cols-2\b/);
  });
});

describe('StoryVisual', () => {
  it('renders a decorative fallback when no image is available', () => {
    render(<StoryVisual seed="e1" label="Machine Learning" />);
    const fallback = screen.getByTestId('story-visual-fallback');
    expect(fallback).toHaveAttribute('aria-hidden', 'true');
    expect(fallback).toHaveTextContent('Machine Learning');
  });

  it('lazy-loads images and swaps to the fallback when the image fails', () => {
    render(<StoryVisual seed="e1" label="Robotics" src="https://img.example/broken.jpg" alt="Factory robot arm" />);
    const img = screen.getByRole('img', { name: 'Factory robot arm' });
    expect(img).toHaveAttribute('loading', 'lazy');
    fireEvent.error(img);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByTestId('story-visual-fallback')).toHaveTextContent('Robotics');
  });

  it('loads the lead image eagerly', () => {
    render(<StoryVisual seed="e1" src="https://img.example/lead.jpg" alt="Lead" priority />);
    expect(screen.getByRole('img', { name: 'Lead' })).toHaveAttribute('loading', 'eager');
  });
});
