/**
 * Article-image URL and credit policy: exact-host HTTPS URL validation, image
 * MIME checks, XML entity decoding and credit normalization. Feed parsing
 * lives in image-extraction.ts.
 *
 * This is intentionally a pure utility: it does not fetch image URLs, access
 * the database, or send image metadata to an AI provider. Callers must pass
 * the exact image hosts allowed for the article's publisher/source.
 */

export const MAX_ARTICLE_IMAGE_URL_LENGTH = 2048;
/** Credits longer than this many code points are cut and end with "…". */
export const MAX_IMAGE_CREDIT_LENGTH = 200;

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg', // Non-standard but common JPEG alias in feeds.
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
]);

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"',
};

export interface ArticleImagePolicyOptions {
  /**
   * Exact hostnames trusted for this publisher/source. Wildcards (`*.host`)
   * and entries with schemes, ports, or trailing dots are ignored.
   */
  allowedHosts: readonly string[];
  /** Optional smaller bound for callers with a tighter storage limit. */
  maxUrlLength?: number;
}

/**
 * Decode the XML entities likely to occur in URLs and RSS HTML fragments.
 * Unknown named entities are preserved rather than interpreted as HTML.
 */
export function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|apos|gt|lt|quot);/gi, (entity, token: string) => {
    if (token[0] !== '#') return XML_ENTITIES[token.toLowerCase()] ?? entity;

    const isHex = token[1]?.toLowerCase() === 'x';
    const codePoint = Number.parseInt(token.slice(isHex ? 2 : 1), isHex ? 16 : 10);
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return entity;

    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return entity;
    }
  });
}

/** Lowercased hostname, or null if invalid. Trailing dots, IPs and wildcards are invalid. */
function normalizeHostname(value: string): string | null {
  const host = value.trim().toLowerCase();
  if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host)) return null;

  const labels = host.split('.');
  if (labels.length < 2 || /^\d+(?:\.\d+){3}$/.test(host)) return null;
  if (labels.some(label =>
    label.length === 0 ||
    label.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  )) return null;

  return host;
}

/** Exact host match only; subdomains must be listed individually. */
function hostIsAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  const host = normalizeHostname(hostname);
  if (!host) return false;
  return allowedHosts.some(entry => normalizeHostname(entry) === host);
}

export function isAllowedImageMimeType(mimeType: string): boolean {
  const normalized = mimeType.split(';', 1)[0].trim().toLowerCase();
  return ALLOWED_IMAGE_MIME_TYPES.has(normalized);
}

function hasSvgExtension(pathname: string): boolean {
  try {
    return /\.svgz?$/i.test(decodeURIComponent(pathname));
  } catch {
    // A malformed escaped path is invalid; fail closed as SVG/unsafe below.
    return true;
  }
}

/**
 * Validate an externally hosted image URL against a source-specific host list.
 * `url` must already be entity-decoded (extractArticleImage decodes each feed
 * layer exactly once); no further decoding happens here.
 * This validates a URL for browser display; it never fetches the remote URL.
 */
export function validateArticleImageUrl(
  url: string | null | undefined,
  options: ArticleImagePolicyOptions,
  declaredMimeType?: string | null,
): string | null {
  if (typeof url !== 'string') return null;

  const trimmed = url.trim();
  const maxLength = options.maxUrlLength ?? MAX_ARTICLE_IMAGE_URL_LENGTH;
  if (!trimmed || trimmed.length > maxLength) return null;
  if (/[\u0000- \u007f\\]/.test(trimmed)) return null;

  // A present MIME type is authoritative: do not accept SVG or other formats.
  if (declaredMimeType && !isAllowedImageMimeType(declaredMimeType)) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password || /:\/\/[^/?#]*@/.test(trimmed)) return null;
  if (parsed.port && parsed.port !== '443') return null;
  if (!hostIsAllowed(parsed.hostname, options.allowedHosts)) return null;
  if (hasSvgExtension(parsed.pathname)) return null;
  // Fragments are never sent to the image host; drop them for a canonical URL.
  parsed.hash = '';
  // Normalization percent-encodes non-ASCII characters, so re-check the length.
  if (parsed.href.length > maxLength) return null;

  return parsed.href;
}

/**
 * Normalize already-decoded credit text to one plain-text line: control
 * characters become spaces, whitespace collapses, and text is kept literally
 * (e.g. "Photo <AP> Wire"). Credits over MAX_IMAGE_CREDIT_LENGTH code points
 * keep their first MAX_IMAGE_CREDIT_LENGTH - 1 code points plus "…".
 */
export function normalizeImageCredit(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const credit = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!credit) return null;
  const codePoints = Array.from(credit);
  if (codePoints.length <= MAX_IMAGE_CREDIT_LENGTH) return credit;
  return `${codePoints.slice(0, MAX_IMAGE_CREDIT_LENGTH - 1).join('').trimEnd()}…`;
}
