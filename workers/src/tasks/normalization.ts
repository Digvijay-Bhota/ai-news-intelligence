/**
 * Article Normalization and Deduplication
 */

/**
 * Generate a deterministic SHA-256 fingerprint for an article.
 */
export async function generateArticleHash(title: string, url: string): Promise<string> {
  const normalizedTitle = title.toLowerCase().trim().replace(/\s+/g, ' ');
  const normalizedUrl = url.toLowerCase().trim();
  const input = `${normalizedTitle}|${normalizedUrl}`;

  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
