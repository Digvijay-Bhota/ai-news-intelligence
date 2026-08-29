/**
 * Caching Utilities
 *
 * KV-backed caching with TTL support.
 */

import type { Env } from '../types';

const DEFAULT_TTL_SECONDS = 300; // 5 minutes

/**
 * Generate a cache key from request parameters.
 */
export function generateCacheKey(
  prefix: string,
  params: Record<string, string | number | boolean | undefined>
): string {
  const sorted = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return `${prefix}:${sorted}`;
}

/**
 * Get a cached value.
 */
export async function getCache<T>(
  key: string,
  env: Env
): Promise<T | null> {
  try {
    const cached = await env.CACHE.get(key);
    if (!cached) return null;
    return JSON.parse(cached) as T;
  } catch {
    return null;
  }
}

/**
 * Set a cached value with optional TTL.
 */
export async function setCache<T>(
  key: string,
  value: T,
  env: Env,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): Promise<void> {
  await env.CACHE.put(key, JSON.stringify(value), {
    expirationTtl: ttlSeconds,
  });
}

/**
 * Delete a cached value.
 */
export async function deleteCache(key: string, env: Env): Promise<void> {
  await env.CACHE.delete(key);
}

/**
 * Cache middleware wrapper for handlers.
 */
export async function withCache<T>(
  key: string,
  fetcher: () => Promise<T>,
  env: Env,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): Promise<T> {
  const cached = await getCache<T>(key, env);
  if (cached !== null) {
    return cached;
  }
  const result = await fetcher();
  await setCache(key, result, env, ttlSeconds);
  return result;
}
