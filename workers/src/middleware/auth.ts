/**
 * Authentication Middleware — Phase 0 (Canonical)
 *
 * Simple configured pipeline token/secret model.
 * HMAC-SHA256 + timestamp + nonce + body hash + method/path binding.
 */

import type { Env } from '../types';
import { UnauthorizedError, ForbiddenError } from '../utils/errors';
import { extractHmacPayload, verifyHmac } from '../utils/hmac';
import { checkReplayProtection } from '../utils/replay';
import { createDbClient } from '../db/client';

export interface AuthContext {
  identifier: string;
  scopes: string[];
  isInternal: boolean;
}

/**
 * Authenticate any request using HMAC.
 * For public API: uses IP as identifier (no token lookup).
 * For internal API: validates pipeline token.
 */
export async function authenticate(
  request: Request,
  env: Env,
  isInternal: boolean
): Promise<AuthContext> {
  const { payload, signature } = await extractHmacPayload(request, env);

  // Verify HMAC against configured secret
  const valid = await verifyHmac(
    payload,
    signature,
    env.HMAC_SECRET,
    env.HMAC_ALGORITHM || 'SHA-256'
  );
  if (!valid) {
    throw new UnauthorizedError('Invalid HMAC signature');
  }

  let identifier: string;
  let scopes: string[] = ['read'];

  if (isInternal) {
    const tokenId = request.headers.get('X-Token-ID');
    if (!tokenId) {
      throw new UnauthorizedError('Missing X-Token-ID header');
    }

    const db = createDbClient(env);
    const token = await db.getPipelineTokenById(tokenId);
    if (!token) {
      throw new UnauthorizedError('Invalid pipeline token');
    }
    if (token.expires_at && token.expires_at < Math.floor(Date.now() / 1000)) {
      throw new UnauthorizedError('Pipeline token expired');
    }

    identifier = tokenId;
    scopes = token.scopes.split(',').map((s) => s.trim());
  } else {
    // Public API: IP-based identifier
    identifier = request.headers.get('CF-Connecting-IP') ??
      request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ??
      'unknown';
  }

  return { identifier, scopes, isInternal };
}

/**
 * Authenticate internal request with replay protection.
 */
export async function authenticateInternal(request: Request, env: Env): Promise<AuthContext> {
  const auth = await authenticate(request, env, true);

  const nonce = request.headers.get(env.NONCE_HEADER || 'X-Nonce');
  const timestampStr = request.headers.get(env.TIMESTAMP_HEADER || 'X-Timestamp');

  if (!nonce || !timestampStr) {
    throw new UnauthorizedError('Missing replay protection headers');
  }

  const timestamp = parseInt(timestampStr, 10);
  const url = new URL(request.url);

  await checkReplayProtection(
    nonce,
    timestamp,
    auth.identifier,
    url.pathname,
    request.method,
    env
  );

  return auth;
}

/**
 * Check required scopes.
 */
export function requireScopes(auth: AuthContext, required: string[]): void {
  const hasAll = required.every((scope) => auth.scopes.includes(scope));
  if (!hasAll) {
    throw new ForbiddenError(`Required scopes: ${required.join(', ')}`);
  }
}
