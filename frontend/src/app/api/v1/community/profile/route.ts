import { getOrCreateUserId } from '../../../../../lib/session';
import { NextRequest, NextResponse } from 'next/server';
import { generateHmac } from '../../../../../utils/hmac';
import { env } from 'cloudflare:workers';
import { getClientIpHeaders, withRateLimitHeaders } from '../../../../../utils/bff';

export const runtime = 'edge';

async function proxyToBackend(request: NextRequest, method: 'GET' | 'PATCH') {
  try {
    const userId = await getOrCreateUserId(request);
    const secret = env.HMAC_SECRET;
    
    if (!secret) {
      return NextResponse.json({ error: 'Missing HMAC_SECRET' }, { status: 500 });
    }

    const backend = env.BACKEND_API;
    if (!backend || typeof backend.fetch !== 'function') {
      return NextResponse.json({ error: 'Missing BACKEND_API binding' }, { status: 500 });
    }

    const ts = Math.floor(Date.now() / 1000);
    const nonce = `nonce-${ts}-${Math.random().toString(36).substring(2, 9)}`;
    const backendPath = '/api/v1/community/profile';

    let body = '';
    if (method === 'PATCH') {
      const json = await request.json();
      // Forward only the allowed fields
      body = JSON.stringify({ display_name: json.display_name });
    }

    const hmacPayload = {
      method,
      path: backendPath,
      timestamp: ts,
      nonce,
      body,
      userId,
    };
    
    const signature = await generateHmac(hmacPayload, secret);

    const backendReq = new Request(`http://backend${backendPath}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-HMAC-Signature': signature,
        'X-Nonce': nonce,
        'X-Timestamp': String(ts),
        'X-Authenticated-User-Id': userId,
        ...getClientIpHeaders(request),
      },
      body: method === 'PATCH' ? body : undefined,
    });

    const backendRes = await backend.fetch(backendReq);

    if (!backendRes.ok) {
      const errorText = await backendRes.text();
      let errorResponse = { error: `Backend error: ${backendRes.status}` };
      try {
        const parsed = JSON.parse(errorText);
        errorResponse = parsed;
      } catch (e) {
        // Not JSON
      }
      return withRateLimitHeaders(NextResponse.json(errorResponse, { status: backendRes.status }), backendRes);
    }

    const data = await backendRes.json();
    const response = NextResponse.json(data);
    
    // Cache safety: profiles are user-specific
    response.headers.set('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    
    return withRateLimitHeaders(response, backendRes);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('BFF Error:', message);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return proxyToBackend(request, 'GET');
}

export async function PATCH(request: NextRequest) {
  return proxyToBackend(request, 'PATCH');
}
