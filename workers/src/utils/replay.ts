/**
 * Replay Attack Protection
 *
 * Uses nonce + timestamp window to prevent replay attacks.
 * Nonces are stored in D1 with a TTL-based cleanup.
 */

import type { Env } from '../types';
import { UnauthorizedError } from './errors';

const DEFAULT_REPLAY_WINDOW_SECONDS = 300; // 5 minutes

/**
 * Check if a nonce has been used before.
 */
export async function isNonceUsed(
  nonce: string,
  env: Env
): Promise<boolean> {
  const stmt = env.DB.prepare(
    'SELECT 1 FROM request_logs WHERE nonce = ?1 LIMIT 1'
  ).bind(nonce);
  const result = await stmt.first();
  return result !== null;
}

/**
 * Record a nonce as used.
 */
export async function recordNonce(
  nonce: string,
  keyId: string,
  endpoint: string,
  method: string,
  env: Env
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO request_logs (nonce, key_id, endpoint, method, timestamp)
     VALUES (?1, ?2, ?3, ?4, ?5)`
  )
    .bind(nonce, keyId, endpoint, method, Math.floor(Date.now() / 1000))
    .run();
}

/**
 * Validate that a timestamp is within the allowed replay window.
 */
export function validateTimestamp(
  timestamp: number,
  env: Env
): void {
  const windowSeconds = parseInt(
    env.REPLAY_WINDOW_SECONDS || String(DEFAULT_REPLAY_WINDOW_SECONDS),
    10
  );
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.abs(now - timestamp);

  if (diff > windowSeconds) {
    throw new UnauthorizedError('Request timestamp outside allowed window');
  }
}

/**
 * Full replay protection check: validate timestamp and nonce uniqueness.
 */
export async function checkReplayProtection(
  nonce: string,
  timestamp: number,
  keyId: string,
  endpoint: string,
  method: string,
  env: Env
): Promise<void> {
  validateTimestamp(timestamp, env);

  const used = await isNonceUsed(nonce, env);
  if (used) {
    throw new UnauthorizedError('Nonce already used');
  }

  await recordNonce(nonce, keyId, endpoint, method, env);
}
