import { FeedResponse, TopicsResponse, SourcesResponse, EventDetailResponse } from '../types';

export async function fetchFeed(
  limit = 20,
  offset = 0,
  q?: string,
  topic?: string,
  source_id?: string,
  topics?: string[],
  sourceNames?: string[],
  signal?: AbortSignal
): Promise<FeedResponse> {
  const params = new URLSearchParams({
    limit: limit.toString(),
    offset: offset.toString()
  });

  if (q) params.set('q', q);
  if (topic) params.set('topic', topic);
  if (source_id) params.set('source_id', source_id);
  if (topics && topics.length > 0) params.set('topics', topics.join(','));
  if (sourceNames && sourceNames.length > 0) params.set('source_names', sourceNames.join(','));

  const res = await fetch(`/api/feed?${params.toString()}`, { signal });
  if (!res.ok) throw new Error('Failed to fetch feed');
  return res.json();
}

export async function fetchTopics(signal?: AbortSignal): Promise<TopicsResponse> {
  const res = await fetch('/api/topics', { signal });
  if (!res.ok) throw new Error('Failed to fetch topics');
  return res.json();
}

export async function fetchSources(signal?: AbortSignal): Promise<SourcesResponse> {
  const res = await fetch('/api/sources', { signal });
  if (!res.ok) throw new Error('Failed to fetch sources');
  return res.json();
}

export async function fetchEvent(hash: string, signal?: AbortSignal): Promise<EventDetailResponse> {
  const res = await fetch(`/api/events/${hash}`, { signal });
  if (!res.ok) throw new Error('Failed to fetch event details');
  return res.json();
}

export async function fetchActiveEvents(signal?: AbortSignal): Promise<{ success: boolean; data: import('../types').EventSummary[] }> {
  const res = await fetch('/api/events', { signal });
  if (!res.ok) throw new Error('Failed to fetch active events');
  return res.json();
}
