import { describe, it, expect } from 'vitest';
import { getEventFreshness } from '../src/utils/freshness';

describe('getEventFreshness', () => {
  const NOW = 1000000;
  
  it('returns active for null timestamp', () => {
    expect(getEventFreshness(null, 5, NOW)).toBe('active');
  });

  it('returns developing for <24h and >1 article', () => {
    // 23 hours ago
    const lastPub = NOW - (23 * 3600);
    expect(getEventFreshness(lastPub, 2, NOW)).toBe('developing');
  });

  it('returns active for <24h but 1 article', () => {
    // 23 hours ago
    const lastPub = NOW - (23 * 3600);
    expect(getEventFreshness(lastPub, 1, NOW)).toBe('active');
  });

  it('handles exactly 24h boundary', () => {
    // Exactly 24h elapsed is NOT strictly less than 24h, so it drops to active
    const lastPub = NOW - 86400;
    expect(getEventFreshness(lastPub, 5, NOW)).toBe('active');
  });

  it('returns active for between 24h and 48h', () => {
    // 36 hours ago
    const lastPub = NOW - (36 * 3600);
    expect(getEventFreshness(lastPub, 10, NOW)).toBe('active');
  });

  it('handles exactly 48h boundary', () => {
    // exactly 48h elapsed is stale
    const lastPub = NOW - 172800;
    expect(getEventFreshness(lastPub, 5, NOW)).toBe('stale');
  });

  it('returns stale for >48h', () => {
    // 50 hours ago
    const lastPub = NOW - (50 * 3600);
    expect(getEventFreshness(lastPub, 2, NOW)).toBe('stale');
  });
});
