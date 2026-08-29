/**
 * Request Body Size Limit Utilities — Phase 0 (Canonical)
 *
 * Public JSON: 64 KB
 * Internal JSON: 256 KB
 */

import type { Env } from '../types';
import { PayloadTooLargeError } from './errors';

const PUBLIC_BODY_LIMIT = 64 * 1024;   // 64 KB
const INTERNAL_BODY_LIMIT = 256 * 1024; // 256 KB

/**
 * Get body limit based on route type.
 */
export function getBodyLimit(isInternal: boolean, env?: Env): number {
  if (env) {
    if (isInternal) {
      return parseInt(env.INTERNAL_BODY_LIMIT_BYTES || String(INTERNAL_BODY_LIMIT), 10);
    }
    return parseInt(env.PUBLIC_BODY_LIMIT_BYTES || String(PUBLIC_BODY_LIMIT), 10);
  }
  return isInternal ? INTERNAL_BODY_LIMIT : PUBLIC_BODY_LIMIT;
}

/**
 * Check if request body exceeds limit.
 * Returns the body text if within limits.
 */
export async function readBodyWithLimit(
  request: Request,
  isInternal: boolean,
  env?: Env
): Promise<string> {
  const limit = getBodyLimit(isInternal, env);
  const contentLength = request.headers.get('Content-Length');

  if (contentLength) {
    const length = parseInt(contentLength, 10);
    if (!isNaN(length) && length > limit) {
      throw new PayloadTooLargeError(
        `Body size ${length} exceeds limit of ${limit} bytes`
      );
    }
  }

  const cloned = request.clone();
  const reader = cloned.body?.getReader();
  if (!reader) return '';

  let total = 0;
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      throw new PayloadTooLargeError(
        `Body size exceeds limit of ${limit} bytes`
      );
    }
    chunks.push(value);
  }

  const allBytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    allBytes.set(chunk, offset);
    offset += chunk.length;
  }

  return new TextDecoder().decode(allBytes);
}

/**
 * Parse JSON body with limit.
 */
export async function parseBody<T>(
  request: Request,
  isInternal: boolean,
  env?: Env
): Promise<T> {
  const bodyText = await readBodyWithLimit(request, isInternal, env);
  if (!bodyText) return {} as T;
  try {
    return JSON.parse(bodyText) as T;
  } catch {
    throw new Error('Invalid JSON body');
  }
}
