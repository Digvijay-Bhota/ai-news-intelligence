import { NextRequest, NextResponse } from 'next/server';
import { generateHmac } from '../../../../utils/hmac';
import { env } from 'cloudflare:workers';
import { getOrCreateUserId } from '../../../../lib/session';
import { getClientIpHeaders, withRateLimitHeaders } from '../../../../utils/bff';

export const runtime = 'edge';

const PRIVATE_NO_CACHE_HEADERS: Record<string, string> = {
  'Cache-Control': 'private, no-cache, no-store, must-revalidate',
  Vary: 'Cookie, X-Authenticated-User-Id',
};

export async function GET(request: NextRequest) {
  try {
    const userId = await getOrCreateUserId(request);
    const secret = env.HMAC_SECRET;
    if (!secret) return NextResponse.json({ error: 'Missing HMAC_SECRET' }, { status: 500 });

    const backend = env.BACKEND_API;
    if (!backend || typeof backend.fetch !== 'function') {
      return NextResponse.json({ error: 'Missing BACKEND_API binding' }, { status: 500 });
    }

    const ts = Math.floor(Date.now() / 1000);
    const nonce = `nonce-${ts}-${Math.random().toString(36).substring(2, 9)}`;

    // Build backend path with query params (limit, offset)
    const url = new URL(request.url);
    const limit = url.searchParams.get('limit');
    const offset = url.searchParams.get('offset');

    const params = new URLSearchParams();
    if (limit) params.set('limit', limit);
    if (offset) params.set('offset', offset);

    const queryString = params.toString();
    const backendPath = queryString
      ? `/api/v1/feed/since-last-seen?${queryString}`
      : '/api/v1/feed/since-last-seen';

    const hmacPayload = {
      method: 'GET',
      path: backendPath,
      timestamp: ts,
      nonce,
      body: '',
      userId,
    };

    const signature = await generateHmac(hmacPayload, secret);

    const backendReq = new Request(`http://backend${backendPath}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-HMAC-Signature': signature,
        'X-Nonce': nonce,
        'X-Timestamp': String(ts),
        'X-Authenticated-User-Id': userId,
        ...getClientIpHeaders(request),
      },
    });

    const backendRes = await backend.fetch(backendReq);

    if (!backendRes.ok) {
      const errorText = await backendRes.text();
      return withRateLimitHeaders(
        NextResponse.json(
          { error: `Backend error: ${backendRes.status}`, details: errorText },
          { status: backendRes.status, headers: PRIVATE_NO_CACHE_HEADERS }
        ),
        backendRes
      );
    }

    const data = await backendRes.json();
    return withRateLimitHeaders(
      NextResponse.json(data, {
        headers: PRIVATE_NO_CACHE_HEADERS,
      }),
      backendRes
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('BFF GET /api/feed/since-last-seen Error:', message);
    return NextResponse.json(
      { error: 'Internal Server Error', details: message },
      { status: 500, headers: PRIVATE_NO_CACHE_HEADERS }
    );
  }
}
