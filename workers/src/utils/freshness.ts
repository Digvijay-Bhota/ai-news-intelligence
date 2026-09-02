export type Freshness = "developing" | "active" | "stale";

/**
 * Calculates event freshness deterministically.
 * 
 * DEVELOPING: lastPublishedAt is less than 24 hours old AND articleCount > 1
 * ACTIVE:     everything else that is not stale
 * STALE:      lastPublishedAt is more than 48 hours old
 */
export function getEventFreshness(
  lastPublishedAt: number | null,
  articleCount: number,
  nowSeconds: number
): Freshness {
  if (lastPublishedAt === null) {
    return "active";
  }

  const elapsed = nowSeconds - lastPublishedAt;

  if (elapsed >= 172800) { // 48 hours
    return "stale";
  }

  if (elapsed < 86400 && articleCount > 1) { // 24 hours
    return "developing";
  }

  return "active";
}
