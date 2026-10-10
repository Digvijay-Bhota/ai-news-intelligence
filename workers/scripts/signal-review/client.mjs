/**
 * Signed client for the internal community-signal review API.
 *
 * Signing mirrors workers/src/utils/hmac.ts (generateHmac): HMAC-SHA256 over
 * `method|path|timestamp|nonce|body|userId`, where path includes the query string
 * and userId is the X-Authenticated-User-Id header. Uses only Web APIs (fetch,
 * crypto.subtle), so it runs in Node and in the Workers test runtime alike.
 *
 * Secrets are only ever placed in the authentication headers; they never appear
 * in error messages or output.
 */

const encoder = new TextEncoder();
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const SAFE_SEGMENT = /^[a-zA-Z0-9_-]+$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_CHARS_GLOBAL = /[\u0000-\u001f\u007f-\u009f]/g;

export const ENV_VARS = {
  apiUrl: 'SIGNAL_REVIEW_API_URL',
  hmacSecret: 'HMAC_SECRET',
  tokenId: 'SIGNAL_REVIEW_TOKEN_ID',
  tokenSecret: 'SIGNAL_REVIEW_TOKEN_SECRET',
  reviewerId: 'SIGNAL_REVIEW_REVIEWER_ID',
};

/** Invalid command-line input or configuration; nothing was sent. */
export class UsageError extends Error {}

/** The API rejected the request; `status` is the HTTP status (0 for network failures). */
export class ReviewApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Build and validate configuration from environment variables. */
export function parseConfig(env) {
  const missing = Object.values(ENV_VARS).filter((name) => !env[name] || !String(env[name]).trim());
  if (missing.length > 0) {
    throw new UsageError(`Missing required environment variable(s): ${missing.join(', ')}`);
  }

  let apiUrl;
  try {
    apiUrl = new URL(env[ENV_VARS.apiUrl]);
  } catch {
    throw new UsageError(`${ENV_VARS.apiUrl} is not a valid URL`);
  }
  const isLocal = LOCAL_HOSTS.has(apiUrl.hostname);
  if (apiUrl.protocol !== 'https:' && !(apiUrl.protocol === 'http:' && isLocal)) {
    throw new UsageError(`${ENV_VARS.apiUrl} must use https:// (http:// is only allowed for localhost)`);
  }
  if (apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash || apiUrl.pathname !== '/') {
    throw new UsageError(`${ENV_VARS.apiUrl} must be an origin only, e.g. https://api.example.com`);
  }

  const reviewerId = String(env[ENV_VARS.reviewerId]).trim();
  if (reviewerId.length > 128 || CONTROL_CHARS.test(reviewerId)) {
    throw new UsageError(`${ENV_VARS.reviewerId} must be at most 128 characters with no control characters`);
  }
  for (const key of ['hmacSecret', 'tokenId', 'tokenSecret']) {
    if (CONTROL_CHARS.test(env[ENV_VARS[key]]) || env[ENV_VARS[key]] !== String(env[ENV_VARS[key]]).trim()) {
      throw new UsageError(`${ENV_VARS[key]} must not contain control characters or surrounding whitespace`);
    }
  }

  return {
    apiUrl: apiUrl.origin,
    hmacSecret: env[ENV_VARS.hmacSecret],
    tokenId: env[ENV_VARS.tokenId],
    tokenSecret: env[ENV_VARS.tokenSecret],
    reviewerId,
  };
}

/** Lowercase-hex HMAC-SHA256 signature, identical to the Worker's generateHmac. */
export async function signPayload({ method, path, timestamp, nonce, body, userId }, secret) {
  const data = userId
    ? `${method}|${path}|${timestamp}|${nonce}|${body}|${userId}`
    : `${method}|${path}|${timestamp}|${nonce}|${body}`;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Send one signed request; returns the response's `data` or throws ReviewApiError. */
export async function signedRequest(config, method, pathWithQuery, payload, fetchImpl = fetch) {
  const url = new URL(pathWithQuery, config.apiUrl);
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();
  const signature = await signPayload(
    { method, path: url.pathname + url.search, timestamp, nonce, body, userId: config.reviewerId },
    config.hmacSecret
  );

  const headers = {
    'X-HMAC-Signature': signature,
    'X-Nonce': nonce,
    'X-Timestamp': String(timestamp),
    'X-Token-ID': config.tokenId,
    'X-Token-Secret': config.tokenSecret,
    'X-Authenticated-User-Id': config.reviewerId,
  };
  if (body) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetchImpl(new Request(url, { method, headers, body: body || undefined }));
  } catch (err) {
    throw new ReviewApiError(0, `Request to ${url.origin} failed: ${err instanceof Error ? err.message : 'network error'}`);
  }

  let json = null;
  try {
    json = await res.json();
  } catch {
    // Non-JSON response (e.g. a proxy error page); reported by status below.
  }
  if (!res.ok || !json || json.success !== true) {
    const message = json && typeof json.error === 'string' ? json.error : `Unexpected response (HTTP ${res.status})`;
    throw new ReviewApiError(res.status, sanitizeForTerminal(message));
  }
  return json.data;
}

function requireSegment(value, name) {
  if (typeof value !== 'string' || !SAFE_SEGMENT.test(value)) {
    throw new UsageError(`${name} must contain only letters, digits, '-' or '_'`);
  }
  return value;
}

export function listCandidates(config, eventHash, { limit } = {}, fetchImpl) {
  const hash = requireSegment(eventHash, 'event hash');
  let query = '';
  if (limit !== undefined) {
    if (!/^\d+$/.test(String(limit))) throw new UsageError('--limit must be a positive integer');
    query = `?limit=${Number(limit)}`;
  }
  return signedRequest(config, 'GET', `/internal/v1/events/${hash}/community/signals/candidates${query}`, undefined, fetchImpl);
}

export function approveSignal(config, eventHash, signalId, fetchImpl) {
  const path = `/internal/v1/events/${requireSegment(eventHash, 'event hash')}/community/signals/${requireSegment(signalId, 'signal ID')}/review`;
  return signedRequest(config, 'POST', path, { status: 'approved' }, fetchImpl);
}

export function rejectSignal(config, eventHash, signalId, reason, fetchImpl) {
  const path = `/internal/v1/events/${requireSegment(eventHash, 'event hash')}/community/signals/${requireSegment(signalId, 'signal ID')}/review`;
  if (typeof reason !== 'string' || !reason.trim()) {
    throw new UsageError('A non-empty --reason is required to reject a signal');
  }
  return signedRequest(config, 'POST', path, { status: 'rejected', reason: reason.trim() }, fetchImpl);
}

/** Replace control characters (including terminal escape sequences) in untrusted text. */
export function sanitizeForTerminal(text) {
  return String(text).replace(CONTROL_CHARS_GLOBAL, ' ');
}

/** Human-readable listing; all user-generated text is sanitized. */
export function formatCandidates(data) {
  const lines = [];
  if (data.candidates.length === 0) {
    lines.push('No candidate signals awaiting review.');
  }
  for (const c of data.candidates) {
    lines.push(`Signal ${sanitizeForTerminal(c.id)}  [${sanitizeForTerminal(c.type)}]  created ${new Date(c.created_at * 1000).toISOString()}`);
    lines.push(`  Content: ${sanitizeForTerminal(c.content)}`);
    lines.push(
      `  Evidence: ${c.active_evidence_count} active post(s) from ${c.distinct_author_count} author(s)` +
        (c.meets_public_threshold ? '' : ' (below the 3 posts / 3 authors needed to show publicly once approved)')
    );
    for (const e of c.evidence) {
      const more = e.body_truncated ? ' […]' : '';
      lines.push(`    - ${sanitizeForTerminal(e.post_id)} (${new Date(e.created_at * 1000).toISOString()}): ${sanitizeForTerminal(e.body)}${more}`);
    }
    if (c.evidence.length < c.active_evidence_count) {
      lines.push(`    (${c.active_evidence_count - c.evidence.length} more evidence post(s) not shown)`);
    }
    lines.push('');
  }
  if (data.has_more) {
    lines.push(`More candidates exist beyond the first ${data.limit}; review these, then list again.`);
  }
  return lines.join('\n');
}
