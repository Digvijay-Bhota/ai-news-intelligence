export async function fetchFeed() {
  const res = await fetch('/api/feed');
  if (!res.ok) throw new Error('Failed to fetch feed');
  return res.json();
}
