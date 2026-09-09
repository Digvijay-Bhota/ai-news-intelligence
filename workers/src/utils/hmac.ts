/**
 * HMAC Authentication Utilities — Phase 0 (Canonical)
 *
 * Signs and verifies requests using HMAC-SHA256.
 * Payload format: method|path|timestamp|nonce|body_hash
 * Uses a single configured pipeline token/secret.
 */

import type { Env } from '../types';
import { UnauthorizedError } from './errors';

export interface HmacPayload {
  method: string;
  path: string;
  timestamp: number;
  nonce: string;
  body: string;
}

/**
 * Generate HMAC signature for a request payload.
 */
export async function generateHmac(
  payload: HmacPayload,
  secret: string,
  algorithm: string = 'SHA-256'
): Promise<string> {
  const encoder = new TextEncoder();
  const data = `${payload.method}|${payload.path}|${payload.timestamp}|${payload.nonce}|${payload.body}`;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: algorithm },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return arrayBufferToHex(signature);
}

/**
 * Verify an incoming HMAC signature.
 */
export async function verifyHmac(
  payload: HmacPayload,
  signature: string,
  secret: string,
  algorithm: string = 'SHA-256'
): Promise<boolean> {
  const expected = await generateHmac(payload, secret, algorithm);
  return timingSafeEqual(signature, expected);
}

/**
 * Extract HMAC payload from a Request.
 */
export async function extractHmacPayload(
  request: Request,
  env: Env
): Promise<{ payload: HmacPayload; signature: string }> {
  const signature = request.headers.get(env.HMAC_HEADER || 'X-HMAC-Signature');
  const nonce = request.headers.get(env.NONCE_HEADER || 'X-Nonce');
  const timestampStr = request.headers.get(env.TIMESTAMP_HEADER || 'X-Timestamp');

  if (!signature || !nonce || !timestampStr) {
    throw new UnauthorizedError('Missing HMAC headers');
  }

  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp)) {
    throw new UnauthorizedError('Invalid timestamp');
  }

  const url = new URL(request.url);
  const body = request.body ? await request.clone().text() : '';

  const payload: HmacPayload = {
    method: request.method,
    path: url.pathname + url.search,
    timestamp,
    nonce,
    body,
  };

  return { payload, signature };
}

/**
 * Build a signed request for testing or external callers.
 */
export async function buildSignedRequest(
  request: Request,
  secret: string,
  nonce: string,
  timestamp: number
): Promise<Request> {
  const url = new URL(request.url);
  const body = request.body ? await request.clone().text() : '';
  const payload: HmacPayload = {
    method: request.method,
    path: url.pathname + url.search,
    timestamp,
    nonce,
    body,
  };
  const signature = await generateHmac(payload, secret);

  const headers = new Headers(request.headers);
  headers.set('X-HMAC-Signature', signature);
  headers.set('X-Nonce', nonce);
  headers.set('X-Timestamp', String(timestamp));

  return new Request(request, { headers });
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  let result = 0;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const charA = i < a.length ? a.charCodeAt(i) : 0;
    const charB = i < b.length ? b.charCodeAt(i) : 0;
    result |= charA ^ charB;
  }
  return result === 0 && a.length === b.length;
}

/**
 * Convert ArrayBuffer to hex string.
 */
function arrayBufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
