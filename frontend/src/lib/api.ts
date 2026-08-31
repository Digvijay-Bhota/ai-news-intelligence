import { FeedResponse } from '../types';

export async function fetchFeed(limit = 20, offset = 0, signal?: AbortSignal): Promise<FeedResponse> {
  const params = new URLSearchParams({
    limit: limit.toString(),
    offset: offset.toString()
  });
  const res = await fetch(`/api/feed?${params.toString()}`, { signal });
  if (!res.ok) throw new Error('Failed to fetch feed');
  return res.json();
}
