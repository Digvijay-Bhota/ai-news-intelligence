/**
 * Exact image-host allow-list per canonical source name (sources.name).
 *
 * Only hosts explicitly reviewed for a source belong here; never add wildcard,
 * parent-domain, sibling-domain or suffix entries. Removing a host here also
 * hides already-stored URLs, because API responses re-validate against this
 * list. Approval to store and return metadata is not approval to display it.
 *
 * Reviewed:
 * - The Verge: platform.theverge.com (approved for Phase 2 metadata only).
 * Not approved (no reviewed host yet): TechCrunch, Ars Technica.
 */

const NO_HOSTS: readonly string[] = Object.freeze([]);

const APPROVED_IMAGE_HOSTS: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, readonly string[]>, {
    'The Verge': Object.freeze(['platform.theverge.com']),
  }),
);

/**
 * Exact hosts approved for a source. Matching is exact and case-sensitive on
 * the canonical name; anything else (unknown, differently cased, padded or
 * missing) gets no hosts.
 */
export function approvedImageHostsForSource(sourceName: string | null | undefined): readonly string[] {
  if (typeof sourceName !== 'string') return NO_HOSTS;
  return Object.prototype.hasOwnProperty.call(APPROVED_IMAGE_HOSTS, sourceName)
    ? APPROVED_IMAGE_HOSTS[sourceName]
    : NO_HOSTS;
}
