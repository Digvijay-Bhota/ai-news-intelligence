/**
 * CORS Middleware — Phase 0 (Canonical)
 */

import type { Env } from '../types';
import { buildCorsConfig, buildCorsHeaders, handlePreflight } from '../utils/cors';

export function applyCors(
  request: Request,
  response: Response,
  env: Env,
  extraHeaders?: Record<string, string>
): Response {
  const config = buildCorsConfig(env);
  const corsHeaders = buildCorsHeaders(request, config);

  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    newHeaders.set(key, value);
  }
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      newHeaders.set(key, value);
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

export function handleCorsPreflight(request: Request, env: Env): Response | null {
  if (request.method === 'OPTIONS') {
    const config = buildCorsConfig(env);
    return handlePreflight(request, config);
  }
  return null;
}
