/**
 * Article image metadata at the system boundaries: extraction during RSS
 * ingestion, and re-validation whenever an API response is built. Neither path
 * fetches images or calls a model, and neither throws.
 */

import { extractArticleImage, MAX_ARTICLE_RAW_CONTENT_LENGTH } from './image-extraction';
import { normalizeImageCredit, validateArticleImageUrl } from './image-policy';
import { approvedImageHostsForSource } from './image-hosts';

export interface ArticleImageFields {
  image_url: string | null;
  image_credit: string | null;
}

export type HostsForSource = (sourceName: string | null | undefined) => readonly string[];

function noImage(): ArticleImageFields {
  return { image_url: null, image_credit: null };
}

/**
 * Image metadata for a newly ingested RSS entry. Returns nulls for sources
 * without approved hosts, absent or oversized content, entries with no
 * eligible image, and any unexpected error, so it can never block article
 * creation. `deps` exists for tests.
 */
export function extractArticleImageFields(
  rawContent: string | null | undefined,
  sourceName: string | null | undefined,
  deps: { hostsFor?: HostsForSource; extract?: typeof extractArticleImage } = {},
): ArticleImageFields {
  try {
    const allowedHosts = (deps.hostsFor ?? approvedImageHostsForSource)(sourceName);
    if (allowedHosts.length === 0) return noImage();
    if (typeof rawContent !== 'string' || rawContent.length > MAX_ARTICLE_RAW_CONTENT_LENGTH) return noImage();
    const image = (deps.extract ?? extractArticleImage)(rawContent, { allowedHosts });
    return image ? { image_url: image.url, image_credit: image.credit } : noImage();
  } catch {
    return noImage();
  }
}

/**
 * Re-validate stored image metadata for an API response against the current
 * exact hosts of the article's source (`item.source` is the source name).
 * Missing, malformed, unapproved or revoked URLs give null for both fields;
 * a credit is only returned alongside a valid URL.
 */
export function sanitizeArticleImageFields<T extends { source: string }>(
  item: T & { image_url?: unknown; image_credit?: unknown },
  hostsFor: HostsForSource = approvedImageHostsForSource,
): Omit<T, 'image_url' | 'image_credit'> & ArticleImageFields {
  let fields = noImage();
  try {
    const allowedHosts = hostsFor(item.source);
    const url = typeof item.image_url === 'string' && allowedHosts.length > 0
      ? validateArticleImageUrl(item.image_url, { allowedHosts })
      : null;
    if (url) {
      fields = {
        image_url: url,
        image_credit: typeof item.image_credit === 'string' ? normalizeImageCredit(item.image_credit) : null,
      };
    }
  } catch {
    fields = noImage();
  }
  return { ...item, ...fields };
}
