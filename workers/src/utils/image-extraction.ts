/**
 * RSS/Atom article-image extraction: scans one feed entry for Media RSS,
 * enclosure and embedded HTML image candidates, then returns the first one that
 * passes validateArticleImageUrl. Pure: no fetch, database, environment or
 * model access.
 */

import {
  decodeXmlEntities,
  isAllowedImageMimeType,
  normalizeImageCredit,
  validateArticleImageUrl,
  type ArticleImagePolicyOptions,
} from './image-policy';

/**
 * Entries longer than this (in UTF-16 code units) are not parsed at all and
 * yield no image. Bounds regex work per entry; content is never truncated,
 * because a truncated entry could be malformed markup.
 */
export const MAX_ARTICLE_RAW_CONTENT_LENGTH = 32 * 1024;
/** Declared widths/heights below this are spacers, icons or tracking pixels. */
export const MIN_IMAGE_DIMENSION = 32;

export type ArticleImageSource =
  | 'media-content'
  | 'media-thumbnail'
  | 'rss-enclosure'
  | 'atom-enclosure'
  | 'html-content';

export interface ExtractedArticleImage {
  /** Validated, normalized HTTPS URL. */
  url: string;
  /** Field from which the URL was extracted; useful for diagnostics/tests. */
  source: ArticleImageSource;
  /**
   * Explicit image credit, only when the feed structure ties it to this image.
   * Authors/bylines are never credits; ambiguous credits are returned as null.
   */
  credit: string | null;
}

/** Media RSS credit scope: item, media:group, media:content or media:thumbnail. */
interface CreditScope {
  parent: CreditScope | null;
  credits: string[];
}

interface ImageCandidate {
  url: string;
  source: ArticleImageSource;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  /** Credit declared on the element itself (e.g. a `credit` attribute). */
  ownCredit: string | null;
  /** Media RSS scope for inherited credits; null for non-Media-RSS elements. */
  scope: CreditScope | null;
  order: number;
}

interface HtmlTag {
  closing: boolean;
  selfClosing: boolean;
  localName: string;
  attributes: Record<string, string>;
}

/** Parse attributes, decoding entities in each value exactly once. */
export function parseAttributes(rawAttributes: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const match of rawAttributes.matchAll(pattern)) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attributes[name] = decodeXmlEntities(value);
  }
  return attributes;
}

/** Extract HTML opening and closing tags while respecting `>` inside quoted attributes. */
function htmlTags(html: string): HtmlTag[] {
  const tags: HtmlTag[] = [];
  const pattern = /<(\/?)([a-z_][\w:.-]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
  for (const match of html.matchAll(pattern)) {
    tags.push({
      closing: match[1] === '/',
      selfClosing: /\/\s*$/.test(match[3]),
      localName: match[2].split(':').pop()!.toLowerCase(),
      attributes: parseAttributes(match[3]),
    });
  }
  return tags;
}

/** Declared pixel size: a number, or null when absent or not a plain pixel value. */
function declaredDimension(value: string | undefined): number | null {
  const match = value ? /^\s*(\d{1,6})(?:px)?\s*$/i.exec(value) : null;
  return match ? Number(match[1]) : null;
}

function isTooSmall(width: number | null, height: number | null): boolean {
  return (width !== null && width < MIN_IMAGE_DIMENSION) ||
    (height !== null && height < MIN_IMAGE_DIMENSION);
}

export const CDATA_PATTERN = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

/** XML element text: CDATA sections are literal, other text is entity-decoded once. */
export function xmlTextContent(raw: string): string {
  let text = '';
  let last = 0;
  for (const match of raw.matchAll(CDATA_PATTERN)) {
    text += decodeXmlEntities(raw.slice(last, match.index)) + match[1];
    last = match.index! + match[0].length;
  }
  return text + decodeXmlEntities(raw.slice(last));
}

/**
 * Remove XML comments outside CDATA sections in one linear pass. Returns null
 * for an unterminated comment (malformed entry). Expects balanced CDATA.
 * The next comment/CDATA positions are cached and only searched again once
 * passed, so many comments or CDATA sections cannot each rescan the entry.
 */
function stripComments(xml: string): string | null {
  let out = '';
  let at = 0;
  let nextComment = xml.indexOf('<!--');
  let nextCdata = xml.indexOf('<![CDATA[');
  while (nextComment !== -1) {
    if (nextCdata !== -1 && nextCdata < nextComment) {
      const cdataEnd = xml.indexOf(']]>', nextCdata + 9) + 3;
      out += xml.slice(at, cdataEnd);
      at = cdataEnd;
    } else {
      const commentEnd = xml.indexOf('-->', nextComment + 4);
      if (commentEnd === -1) return null;
      out += xml.slice(at, nextComment);
      at = commentEnd + 3;
    }
    if (nextComment < at) nextComment = xml.indexOf('<!--', at);
    if (nextCdata !== -1 && nextCdata < at) nextCdata = xml.indexOf('<![CDATA[', at);
  }
  return out + xml.slice(at);
}

/** True when every CDATA section is terminated (one linear pass). */
function hasBalancedCdata(xml: string): boolean {
  for (let at = xml.indexOf('<![CDATA['); at !== -1; at = xml.indexOf('<![CDATA[', at)) {
    const end = xml.indexOf(']]>', at + 9);
    if (end === -1) return false;
    at = end + 3;
  }
  return true;
}

type ClosingTagFinder = (rawName: string, from: number) => { start: number; end: number } | null;

/**
 * Closing-tag search over the masked entry. A failed search is remembered per
 * element name, so many unclosed openers cannot each rescan the rest of the
 * entry (which would be quadratic on malformed input).
 */
function closingTagFinder(masked: string): ClosingTagFinder {
  const noCloseFrom = new Map<string, number>();
  return (rawName, from) => {
    const key = rawName.toLowerCase();
    const failedFrom = noCloseFrom.get(key);
    if (failedFrom !== undefined && from >= failedFrom) return null;
    const pattern = new RegExp(`</${rawName.replace(/\./g, '\\.')}\\s*>`, 'gi');
    pattern.lastIndex = from;
    const match = pattern.exec(masked);
    if (!match) {
      noCloseFrom.set(key, Math.min(failedFrom ?? from, from));
      return null;
    }
    return { start: match.index, end: match.index + match[0].length };
  };
}

/**
 * The most specific Media RSS scope that declares credits decides (content >
 * group > item, per the Media RSS precedence rules). More than one distinct
 * credit at that level is ambiguous, so no credit is returned.
 */
function scopedCredit(scope: CreditScope | null): string | null {
  for (let current = scope; current; current = current.parent) {
    const distinct = new Set(current.credits);
    if (distinct.size > 0) return distinct.size === 1 ? current.credits[0] : null;
  }
  return null;
}

/**
 * Parse a srcset value and return its URLs, largest first (by `w`, then `x`).
 * Follows the HTML candidate grammar, so URLs may contain commas
 * (e.g. `https://cdn.example/c_fill,w_800/a.jpg 800w`).
 */
function srcsetUrlsLargestFirst(srcset: string): string[] {
  const candidates: { url: string; w: number; x: number; order: number }[] = [];
  let i = 0;
  while (i < srcset.length) {
    while (i < srcset.length && /[\s,]/.test(srcset[i])) i++;
    const urlStart = i;
    while (i < srcset.length && !/\s/.test(srcset[i])) i++;
    let url = srcset.slice(urlStart, i);
    let descriptor = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      const descriptorStart = i;
      while (i < srcset.length && srcset[i] !== ',') i++;
      descriptor = srcset.slice(descriptorStart, i).trim();
    }
    if (!url) continue;
    const width = /^(\d+)w$/i.exec(descriptor);
    const density = /^(\d+(?:\.\d+)?)x$/i.exec(descriptor);
    candidates.push({
      url,
      w: width ? Number(width[1]) : 0,
      x: density ? Number(density[1]) : descriptor ? 0 : 1,
      order: candidates.length,
    });
  }
  return candidates
    .sort((a, b) => b.w - a.w || b.x - a.x || a.order - b.order)
    .map(c => c.url);
}

const MEDIA_SCOPE_ELEMENTS = new Set(['group', 'content', 'thumbnail']);
const MAX_MEDIA_SCOPE_DEPTH = 16;
const HTML_FIELDS = new Set(['description', 'summary', 'content', 'encoded']);

interface EntryScan {
  candidates: ImageCandidate[];
  htmlBodies: string[];
  itemScope: CreditScope;
  allCredits: string[];
  imageElements: number;
}

/**
 * Walk the entry's XML structure (CDATA masked out) to collect image
 * elements, Media RSS credit scopes, and decoded HTML bodies.
 */
function scanEntry(xml: string): EntryScan {
  // Same-length masking keeps indexes aligned with the original text.
  const masked = xml.replace(CDATA_PATTERN, m => ' '.repeat(m.length));
  const findClose = closingTagFinder(masked);
  const itemScope: CreditScope = { parent: null, credits: [] };
  const stack: { name: string; scope: CreditScope }[] = [];
  const scan: EntryScan = { candidates: [], htmlBodies: [], itemScope, allCredits: [], imageElements: 0 };
  const tagPattern = /<(\/?)([a-z_][\w:.-]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;

  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(masked))) {
    const [whole, closing, rawName, rawAttributes] = match;
    const name = rawName.toLowerCase();
    const colon = name.lastIndexOf(':');
    const prefix = colon === -1 ? null : name.slice(0, colon);
    const localName = name.slice(colon + 1);
    const scope = stack.length ? stack[stack.length - 1].scope : itemScope;

    if (closing) {
      // Only Media RSS scopes are tracked; other closing tags cannot change them.
      if (prefix !== 'media' || !MEDIA_SCOPE_ELEMENTS.has(localName)) continue;
      for (let open = stack.length - 1; open >= 0; open--) {
        if (stack[open].name === name) {
          stack.length = open;
          break;
        }
      }
      continue;
    }

    const selfClosing = /\/\s*$/.test(rawAttributes);
    const attrs = parseAttributes(rawAttributes);
    const end = match.index + whole.length;

    if (prefix === 'media' && localName === 'credit') {
      const close = selfClosing ? null : findClose(rawName, end);
      if (!close) continue;
      const credit = normalizeImageCredit(xmlTextContent(xml.slice(end, close.start)));
      if (credit) {
        scope.credits.push(credit);
        scan.allCredits.push(credit);
      }
      tagPattern.lastIndex = close.end;
      continue;
    }

    if (prefix === 'media' && MEDIA_SCOPE_ELEMENTS.has(localName)) {
      const own: CreditScope = { parent: scope, credits: [] };
      // Real Media RSS nesting is shallow (group > content > thumbnail); deeper
      // unclosed openers are not tracked, which bounds closing-tag lookups.
      if (!selfClosing && stack.length < MAX_MEDIA_SCOPE_DEPTH) stack.push({ name, scope: own });
      const url = attrs.url ?? attrs.href;
      if (localName === 'group' || !url) continue;
      const mimeType = attrs.type ?? null;
      if (localName === 'content' && attrs.medium?.toLowerCase() !== 'image' && !mimeType?.toLowerCase().startsWith('image/')) continue;
      const width = declaredDimension(attrs.width);
      const height = declaredDimension(attrs.height);
      if (isTooSmall(width, height)) continue;
      scan.imageElements++;
      scan.candidates.push({
        url,
        source: localName === 'content' ? 'media-content' : 'media-thumbnail',
        mimeType,
        width,
        height,
        ownCredit: normalizeImageCredit(attrs.credit),
        scope: own,
        order: scan.candidates.length,
      });
      continue;
    }

    if (prefix !== 'media' && HTML_FIELDS.has(localName)) {
      const close = selfClosing ? null : findClose(rawName, end);
      if (!close) continue;
      const type = attrs.type?.toLowerCase();
      const body = xml.slice(end, close.start);
      // Atom type="text" carries no markup; type="xhtml" is inline XML markup
      // whose attributes are decoded once by parseAttributes.
      if (type !== 'text') scan.htmlBodies.push(type === 'xhtml' ? body : xmlTextContent(body));
      tagPattern.lastIndex = close.end;
      continue;
    }

    const url = attrs.url ?? attrs.href;
    const mimeType = attrs.type ?? null;
    if (!url || !mimeType?.toLowerCase().startsWith('image/')) continue;
    const isRssEnclosure = !prefix && localName === 'enclosure';
    const isAtomEnclosure = localName === 'link' &&
      !!attrs.rel?.split(/\s+/).some(rel => rel.toLowerCase() === 'enclosure');
    if (!isRssEnclosure && !isAtomEnclosure) continue;
    const width = declaredDimension(attrs.width);
    const height = declaredDimension(attrs.height);
    if (isTooSmall(width, height)) continue;
    scan.imageElements++;
    scan.candidates.push({
      url,
      source: isRssEnclosure ? 'rss-enclosure' : 'atom-enclosure',
      mimeType,
      width,
      height,
      ownCredit: normalizeImageCredit(attrs.credit),
      scope: null,
      order: scan.candidates.length,
    });
  }

  return scan;
}

function addHtmlImageCandidates(scan: EntryScan): void {
  for (const html of scan.htmlBodies) {
    let pictureDepth = 0;
    for (const tag of htmlTags(html)) {
      if (tag.localName === 'picture') {
        if (tag.closing) pictureDepth = Math.max(0, pictureDepth - 1);
        else if (!tag.selfClosing) pictureDepth++;
        continue;
      }
      if (tag.closing || (tag.localName !== 'img' && tag.localName !== 'source')) continue;

      const attrs = tag.attributes;
      // <source> is an image only with an allowed image type, or untyped inside
      // <picture>; an untyped <source> elsewhere (e.g. <video>) is not an image.
      if (tag.localName === 'source' && (attrs.type ? !isAllowedImageMimeType(attrs.type) : pictureDepth === 0)) continue;

      const width = declaredDimension(attrs.width);
      const height = declaredDimension(attrs.height);
      if (isTooSmall(width, height)) continue;

      // Lazy-load attributes hold the real image; `src` may be a placeholder.
      const urls = [
        attrs['data-src'],
        attrs['data-lazy-src'],
        attrs['data-original'],
        ...(attrs['data-srcset'] ? srcsetUrlsLargestFirst(attrs['data-srcset']) : []),
        attrs.src,
        ...(attrs.srcset ? srcsetUrlsLargestFirst(attrs.srcset) : []),
      ].filter((url): url is string => !!url);
      if (urls.length === 0) continue;

      scan.imageElements++;
      for (const url of urls) {
        scan.candidates.push({
          url,
          source: 'html-content',
          mimeType: attrs.type ?? null,
          width,
          height,
          ownCredit: normalizeImageCredit(attrs['data-credit'] ?? attrs.credit),
          scope: null,
          order: scan.candidates.length,
        });
      }
    }
  }
}

function priority(source: ArticleImageSource): number {
  switch (source) {
    case 'media-content': return 0;
    case 'media-thumbnail': return 1;
    case 'rss-enclosure': return 2;
    case 'atom-enclosure': return 3;
    case 'html-content': return 4;
  }
}

function hasKnownSize(candidate: ImageCandidate): boolean {
  return candidate.width !== null && candidate.height !== null;
}

function area(candidate: ImageCandidate): number {
  return (candidate.width ?? 0) * (candidate.height ?? 0);
}

/**
 * Order candidates for validation. Source type decides first. Within a source
 * type, candidates with both dimensions declared are re-sorted largest-first
 * among the positions they already occupy, while candidates of unknown size
 * keep their feed position. This is a deterministic permutation rather than a
 * pairwise comparator (mixing known and unknown sizes pairwise is not transitive).
 */
function orderCandidates(candidates: readonly ImageCandidate[]): ImageCandidate[] {
  const byType = [...candidates].sort((a, b) => priority(a.source) - priority(b.source) || a.order - b.order);
  const ordered: ImageCandidate[] = [];
  for (let start = 0; start < byType.length;) {
    let end = start;
    while (end < byType.length && byType[end].source === byType[start].source) end++;
    const group = byType.slice(start, end);
    const sized = group.filter(hasKnownSize).sort((a, b) => area(b) - area(a) || a.order - b.order);
    let next = 0;
    for (const candidate of group) ordered.push(hasKnownSize(candidate) ? sized[next++] : candidate);
    start = end;
  }
  return ordered;
}

/**
 * Extract one valid image from an RSS `<item>` or Atom `<entry>` fragment.
 * Candidate order is: Media RSS content image, media thumbnail, RSS enclosure,
 * Atom enclosure, then embedded HTML image/lazy-load attributes (see
 * orderCandidates for ordering within a type). Declared sizes under
 * MIN_IMAGE_DIMENSION are ignored. Invalid candidates are skipped in favor of
 * the next valid one. Entries over MAX_ARTICLE_RAW_CONTENT_LENGTH, or with an
 * unterminated CDATA section or comment, yield null without being parsed.
 *
 * Credits: Media RSS images use their own, group, or item-level `media:credit`
 * (most specific wins). Other images get an item-level credit only when the
 * entry has exactly one image element and exactly one distinct credit.
 */
export function extractArticleImage(
  rawContent: string | null | undefined,
  options: ArticleImagePolicyOptions,
): ExtractedArticleImage | null {
  if (typeof rawContent !== 'string' || !rawContent.trim() || options.allowedHosts.length === 0) {
    return null;
  }
  // Fail closed instead of truncating: a cut entry could be malformed markup.
  if (rawContent.length > MAX_ARTICLE_RAW_CONTENT_LENGTH || !hasBalancedCdata(rawContent)) return null;

  const xml = stripComments(rawContent);
  if (xml === null) return null;
  const scan = scanEntry(xml);
  addHtmlImageCandidates(scan);

  const distinctCredits = new Set(scan.allCredits);
  const unambiguousItemCredit =
    scan.imageElements === 1 && distinctCredits.size === 1 && scan.itemScope.credits.length > 0
      ? scan.itemScope.credits[0]
      : null;

  for (const candidate of orderCandidates(scan.candidates)) {
    const url = validateArticleImageUrl(candidate.url, options, candidate.mimeType);
    if (!url) continue;
    return {
      url,
      source: candidate.source,
      credit: candidate.ownCredit ??
        (candidate.scope ? scopedCredit(candidate.scope) : unambiguousItemCredit),
    };
  }

  return null;
}
