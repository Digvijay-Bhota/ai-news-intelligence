import { describe, it, expect, vi } from 'vitest';
import { fetchFeed } from '../src/lib/api';

describe('Frontend API Client', () => {
  it('fetchFeed calls /api/feed', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const data = await fetchFeed();
    expect(data.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith('/api/feed');
  });

  it('fetchFeed throws on error response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    await expect(fetchFeed()).rejects.toThrow('Failed to fetch feed');
  });
});

describe('Page module', () => {
  it('api.ts exports fetchFeed', async () => {
    const mod = await import('../src/lib/api');
    expect(typeof mod.fetchFeed).toBe('function');
  });

  it('hmac.ts exports generateHmac', async () => {
    const mod = await import('../src/utils/hmac');
    expect(typeof mod.generateHmac).toBe('function');
  });
});
