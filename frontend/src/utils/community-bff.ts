import { getOrCreateUserId } from '../lib/session';
import { NextRequest, NextResponse } from 'next/server';
import { generateHmac } from './hmac';
import { env } from 'cloudflare:workers';
import { getClientIpHeaders, withRateLimitHeaders } from './bff';

export async function proxyCommunityApi(
  request: NextRequest, 
  backendPath: string, 
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  cacheControl: string = 'private, no-store'
) {
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

    let body = '';
    if (['POST', 'PATCH', 'PUT'].includes(method)) {
      try {
        const text = await request.text();
        if (text) body = text;
      } catch (e) {
        // body could be empty or invalid
      }
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
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        'X-HMAC-Signature': signature,
        'X-Nonce': nonce,
        'X-Timestamp': String(ts),
        'X-Authenticated-User-Id': userId,
        ...getClientIpHeaders(request),
      },
      body: body ? body : undefined,
    });

    const backendRes = await backend.fetch(backendReq);

    if (!backendRes.ok) {
      const errorText = await backendRes.text();
      let errorResponse = { error: `Backend error: ${backendRes.status}` };
      try {
        errorResponse = JSON.parse(errorText);
      } catch (e) {}
      return withRateLimitHeaders(NextResponse.json(errorResponse, { status: backendRes.status }), backendRes);
    }

    const data = await backendRes.json();
    const response = NextResponse.json(data);
    response.headers.set('Cache-Control', cacheControl);
    
    return withRateLimitHeaders(response, backendRes);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('BFF Error:', message);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
