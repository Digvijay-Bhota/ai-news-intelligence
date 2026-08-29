/**
 * CORS Configuration Utilities
 */

import type { Env } from '../types';

export interface CorsConfig {
  origin: string | string[];
  methods: string[];
  allowedHeaders: string[];
  exposedHeaders: string[];
  credentials: boolean;
  maxAge: number;
}

const DEFAULT_CONFIG: CorsConfig = {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-HMAC-Signature',
    'X-Nonce',
    'X-Timestamp',
    'X-API-Key',
  ],
  exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  credentials: false,
  maxAge: 86400,
};

/**
 * Build CORS config from environment.
 */
export function buildCorsConfig(env: Env): CorsConfig {
  const origin = env.CORS_ORIGIN || '*';
  return {
    ...DEFAULT_CONFIG,
    origin: origin === '*' ? '*' : origin.split(',').map((o) => o.trim()),
  };
}

/**
 * Check if an origin is allowed.
 */
export function isOriginAllowed(
  requestOrigin: string | null,
  config: CorsConfig
): boolean {
  if (!requestOrigin) return true;
  if (config.origin === '*') return true;
  if (Array.isArray(config.origin)) {
    return config.origin.includes(requestOrigin);
  }
  return config.origin === requestOrigin;
}

/**
 * Build CORS headers for a response.
 */
export function buildCorsHeaders(
  request: Request,
  config: CorsConfig
): Record<string, string> {
  const requestOrigin = request.headers.get('Origin');
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': config.methods.join(', '),
    'Access-Control-Allow-Headers': config.allowedHeaders.join(', '),
    'Access-Control-Expose-Headers': config.exposedHeaders.join(', '),
    'Access-Control-Max-Age': String(config.maxAge),
  };

  if (config.origin === '*') {
    headers['Access-Control-Allow-Origin'] = '*';
  } else if (requestOrigin && isOriginAllowed(requestOrigin, config)) {
    headers['Access-Control-Allow-Origin'] = requestOrigin;
    if (config.credentials) {
      headers['Access-Control-Allow-Credentials'] = 'true';
    }
  }

  return headers;
}

/**
 * Handle preflight OPTIONS request.
 */
export function handlePreflight(request: Request, config: CorsConfig): Response {
  const headers = buildCorsHeaders(request, config);
  return new Response(null, {
    status: 204,
    headers,
  });
}
