/**
 * Settings page: loading, showing and saving the community profile.
 * Responses use the Worker's envelope ({ success, data } / { success: false,
 * error }) as passed through by the /api/v1/community/profile BFF route.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import SettingsPage from '../src/app/settings/page';

vi.mock('../src/lib/api', () => ({
  fetchTopics: vi.fn().mockResolvedValue({ success: true, data: [{ id: 1, name: 'Robotics', slug: 'robotics', description: '', active: 1 }] }),
  fetchSources: vi.fn().mockResolvedValue({ success: true, data: [{ id: 1, name: 'TechCrunch', base_url: '', source_type: 'rss', active: 1 }] }),
}));

const PROFILE = { public_id: 'k3v9x2m7q1w8e5r4t6y0u', display_name: 'Reader_K3V9', status: 'active', created_at: 1760000000 };
const PREFERENCES = { preferred_topics: ['robotics'], preferred_sources: [], digest_frequency: 'daily' };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Route = (init?: RequestInit) => Response | Promise<Response>;

/** Serves the given "METHOD /path" routes; any other request fails the test. */
function serve(routes: Record<string, Route>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const route = routes[`${init?.method ?? 'GET'} ${url}`];
    if (!route) throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
    return route(init);
  });
}

const loadRoutes = (profile: Route): Record<string, Route> => ({
  'GET /api/preferences': () => json({ success: true, data: PREFERENCES }),
  'GET /api/v1/community/profile': profile,
});

async function renderLoaded() {
  render(<SettingsPage />);
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Preferred Topics' })).toBeInTheDocument());
}

describe('Settings community profile', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the loaded profile with its display name and public ID', async () => {
    serve(loadRoutes(() => json({ success: true, data: PROFILE })));
    await renderLoaded();

    expect(screen.getByRole('heading', { name: 'Community Profile' })).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('Reader_K3V9');
    expect(screen.getByText(PROFILE.public_id)).toBeInTheDocument();
  });

  it('hides the profile section when the profile request fails, and still loads preferences', async () => {
    serve(loadRoutes(() => json({ success: false, error: 'Authenticated user identity required' }, 401)));
    await renderLoaded();

    expect(screen.queryByRole('heading', { name: 'Community Profile' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Robotics/ })).toBeChecked();
    expect(screen.queryByText('Failed to load settings.')).not.toBeInTheDocument();
  });

  it('ignores a successful response without a usable profile', async () => {
    serve(loadRoutes(() => json({ success: true, data: { status: 'active' } })));
    await renderLoaded();

    expect(screen.queryByRole('heading', { name: 'Community Profile' })).not.toBeInTheDocument();
  });

  it('ignores a late profile response from a superseded load', async () => {
    // StrictMode runs the load effect twice; the first run's response arrives last.
    let profileCalls = 0;
    serve(loadRoutes(async () => {
      profileCalls++;
      if (profileCalls === 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
        return json({ success: true, data: { ...PROFILE, display_name: 'Stale_Name' } });
      }
      return json({ success: true, data: PROFILE });
    }));
    render(<React.StrictMode><SettingsPage /></React.StrictMode>);

    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Reader_K3V9'));
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(profileCalls).toBe(2);
    expect(screen.getByRole('textbox')).toHaveValue('Reader_K3V9');
  });

  it('saves preferences without a profile update when the display name is unchanged', async () => {
    const fetchSpy = serve({
      ...loadRoutes(() => json({ success: true, data: PROFILE })),
      'POST /api/preferences': () => json({ success: true, data: PREFERENCES }),
    });
    await renderLoaded();

    fireEvent.click(screen.getByRole('button', { name: 'Save Preferences' }));

    await waitFor(() => expect(screen.getByText('Settings saved successfully!')).toBeInTheDocument());
    expect(fetchSpy.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });

  it('saves a changed display name and shows the name the server stored', async () => {
    const fetchSpy = serve({
      ...loadRoutes(() => json({ success: true, data: PROFILE })),
      'POST /api/preferences': () => json({ success: true, data: PREFERENCES }),
      // The Worker trims the name before storing it.
      'PATCH /api/v1/community/profile': () => json({ success: true, data: { ...PROFILE, display_name: 'Ada Lovelace' } }),
    });
    await renderLoaded();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Ada Lovelace  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Preferences' }));

    await waitFor(() => expect(screen.getByText('Settings saved successfully!')).toBeInTheDocument());
    const patch = fetchSpy.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ display_name: '  Ada Lovelace  ' });
    expect(screen.getByRole('textbox')).toHaveValue('Ada Lovelace');
    expect(screen.getByText(PROFILE.public_id)).toBeInTheDocument();
  });

  it('keeps the loaded profile when the display name update is rejected', async () => {
    serve({
      ...loadRoutes(() => json({ success: true, data: PROFILE })),
      'POST /api/preferences': () => json({ success: true, data: PREFERENCES }),
      'PATCH /api/v1/community/profile': () => json({ success: false, error: 'Display name contains invalid characters' }, 400),
    });
    await renderLoaded();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Bad<Name>' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Preferences' }));

    await waitFor(() => expect(screen.getByText('Failed to update display name')).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Community Profile' })).toBeInTheDocument();
    expect(screen.getByText(PROFILE.public_id)).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('Bad<Name>');
  });
});
