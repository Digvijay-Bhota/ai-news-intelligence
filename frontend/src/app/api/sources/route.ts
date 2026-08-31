import { getOrCreateUserId } from '../../../lib/session';
import { NextRequest, NextResponse } from 'next/server';
import { generateHmac } from '../../../utils/hmac';
import { env } from 'cloudflare:workers';

export const runtime = 'edge';

export async function GET(request: NextRequest) {
  try {
    await getOrCreateUserId(request);
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
    const backendPath = '/api/v1/sources';

    // Forward allowed query params (limit, offset, source_id) to backend.
    const searchParams = request.nextUrl.searchParams;
    const queryString = searchParams.toString();
    const fullPath = queryString ? `${backendPath}?${queryString}` : backendPath;

    const hmacPayload = {
      method: 'GET',
      path: fullPath,
      timestamp: ts,
      nonce,
      body: '',
    };

    const signature = await generateHmac(hmacPayload, secret);

    // Service Binding fetch: host is ignored by Cloudflare.
    const backendReq = new Request(`http://backend${fullPath}`, {
      method: 'GET',
      headers: {
        'X-HMAC-Signature': signature,
        'X-Nonce': nonce,
        'X-Timestamp': String(ts),
      },
    });

    const backendRes = await backend.fetch(backendReq);

    if (!backendRes.ok) {
      const errorText = await backendRes.text();
      return NextResponse.json(
        { error: `Backend error: ${backendRes.status}`, details: errorText },
        { status: backendRes.status }
      );
    }

    const data = await backendRes.json();
    return NextResponse.json(data);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('BFF Error:', message);
    return NextResponse.json({ error: 'Internal Server Error', details: message }, { status: 500 });
  }
}
