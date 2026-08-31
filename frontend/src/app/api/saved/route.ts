import { NextRequest, NextResponse } from 'next/server';
import { generateHmac } from '../../../utils/hmac';
import { env } from 'cloudflare:workers';
import { getOrCreateUserId } from '../../../lib/session';

export const runtime = 'edge';

export async function POST(request: NextRequest) {
  try {
    const userId = await getOrCreateUserId(request);
    const body = await request.json();
    const articleRawId = body.article_raw_id;

    if (!articleRawId) {
      return NextResponse.json({ error: 'article_raw_id required' }, { status: 400 });
    }

    const secret = env.HMAC_SECRET;
    if (!secret) return NextResponse.json({ error: 'Missing HMAC_SECRET' }, { status: 500 });

    const backend = env.BACKEND_API;
    if (!backend || typeof backend.fetch !== 'function') return NextResponse.json({ error: 'Missing BACKEND_API binding' }, { status: 500 });

    const ts = Math.floor(Date.now() / 1000);
    const nonce = `nonce-${ts}-${Math.random().toString(36).substring(2, 9)}`;
    const backendPath = '/api/v1/saved';

    const payloadBody = JSON.stringify({ user_id: userId, article_raw_id: articleRawId });

    const hmacPayload = {
      method: 'POST',
      path: backendPath,
      timestamp: ts,
      nonce,
      body: payloadBody,
    };

    const signature = await generateHmac(hmacPayload, secret);

    const backendReq = new Request(`http://backend${backendPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-HMAC-Signature': signature,
        'X-Nonce': nonce,
        'X-Timestamp': String(ts),
      },
      body: payloadBody,
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
    console.error('BFF POST /saved Error:', message);
    return NextResponse.json({ error: 'Internal Server Error', details: message }, { status: 500 });
  }
}
