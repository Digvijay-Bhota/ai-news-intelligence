/**
 * Rate Limit Middleware — Phase 0 (Canonical)
 */

import type { Env } from '../types';
import { checkPublicRateLimit, checkInternalRateLimit } from '../utils/rate-limiter';

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetAt: number;
}

export async function applyPublicRateLimit(
  request: Request,
  endpoint: string,
  env: Env
): Promise<RateLimitInfo> {
  const result = await checkPublicRateLimit(request, endpoint, env);
  return { limit: result.limit, remaining: result.remaining, resetAt: result.resetAt };
}

export async function applyInternalRateLimit(
  tokenId: string,
  endpoint: string,
  env: Env
): Promise<RateLimitInfo> {
  const result = await checkInternalRateLimit(tokenId, endpoint, env);
  return { limit: result.limit, remaining: result.remaining, resetAt: result.resetAt };
}

export function rateLimitHeaders(info: RateLimitInfo): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(info.limit),
    'X-RateLimit-Remaining': String(info.remaining),
    'X-RateLimit-Reset': String(info.resetAt),
  };
}
