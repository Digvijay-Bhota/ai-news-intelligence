/**
 * Rate Limiting Utilities — Phase 0 (Canonical)
 *
 * Public API: IP-based rate limiting
 * Internal API: token_id + endpoint based rate limiting
 */

import type { Env } from '../types';
import { RateLimitError } from './errors';

const DEFAULT_PUBLIC_WINDOW = 60;
const DEFAULT_PUBLIC_MAX = 100;
const DEFAULT_INTERNAL_WINDOW = 60;
const DEFAULT_INTERNAL_MAX = 1000;

/**
 * Get client IP from request headers.
 */
export function getClientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

/**
 * Check public (IP-based) rate limit.
 */
export async function checkPublicRateLimit(
  request: Request,
  endpoint: string,
  env: Env
): Promise<{ allowed: boolean; remaining: number; resetAt: number; limit: number }> {
  const identifier = getClientIp(request);
  const windowSeconds = parseInt(
    env.PUBLIC_RATE_LIMIT_WINDOW_SECONDS || String(DEFAULT_PUBLIC_WINDOW),
    10
  );
  const maxRequests = parseInt(
    env.PUBLIC_RATE_LIMIT_MAX_REQUESTS || String(DEFAULT_PUBLIC_MAX),
    10
  );

  return checkRateLimit(identifier, endpoint, windowSeconds, maxRequests, env);
}

/**
 * Check internal (token-based) rate limit.
 */
export async function checkInternalRateLimit(
  tokenId: string,
  endpoint: string,
  env: Env
): Promise<{ allowed: boolean; remaining: number; resetAt: number; limit: number }> {
  const windowSeconds = parseInt(
    env.INTERNAL_RATE_LIMIT_WINDOW_SECONDS || String(DEFAULT_INTERNAL_WINDOW),
    10
  );
  const maxRequests = parseInt(
    env.INTERNAL_RATE_LIMIT_MAX_REQUESTS || String(DEFAULT_INTERNAL_MAX),
    10
  );

  return checkRateLimit(tokenId, endpoint, windowSeconds, maxRequests, env);
}

/**
 * Core rate limit check backed by D1.
 */
async function checkRateLimit(
  identifier: string,
  endpoint: string,
  windowSeconds: number,
  maxRequests: number,
  env: Env
): Promise<{ allowed: boolean; remaining: number; resetAt: number; limit: number }> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / windowSeconds) * windowSeconds;
  const resetAt = windowStart + windowSeconds;

  const result = await env.DB.prepare(
    `INSERT INTO rate_limit_logs (identifier, endpoint, window_start, request_count)
     VALUES (?1, ?2, ?3, 1)
     ON CONFLICT DO UPDATE SET
       request_count = request_count + 1
     WHERE identifier = ?1 AND endpoint = ?2 AND window_start = ?3
     RETURNING request_count`
  )
    .bind(identifier, endpoint, windowStart)
    .first<{ request_count: number }>();

  // Fallback: if RETURNING not supported, query separately
  let count = result?.request_count ?? 1;
  if (!result) {
    const existing = await env.DB.prepare(
      `SELECT request_count FROM rate_limit_logs
       WHERE identifier = ?1 AND endpoint = ?2 AND window_start = ?3`
    )
      .bind(identifier, endpoint, windowStart)
      .first<{ request_count: number }>();
    count = existing?.request_count ?? 1;
  }

  const remaining = Math.max(0, maxRequests - count);
  const allowed = count <= maxRequests;

  if (!allowed) {
    throw new RateLimitError(
      `Rate limit exceeded. Retry after ${resetAt - now}s.`,
      resetAt - now
    );
  }

  return { allowed, remaining, resetAt, limit: maxRequests };
}

/**
 * Get current rate limit status.
 */
export async function getRateLimitStatus(
  identifier: string,
  endpoint: string,
  windowSeconds: number,
  maxRequests: number,
  env: Env
): Promise<{ limit: number; remaining: number; resetAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / windowSeconds) * windowSeconds;
  const resetAt = windowStart + windowSeconds;

  const result = await env.DB.prepare(
    `SELECT request_count FROM rate_limit_logs
     WHERE identifier = ?1 AND endpoint = ?2 AND window_start = ?3`
  )
    .bind(identifier, endpoint, windowStart)
    .first<{ request_count: number }>();

  const count = result?.request_count ?? 0;
  return {
    limit: maxRequests,
    remaining: Math.max(0, maxRequests - count),
    resetAt,
  };
}
