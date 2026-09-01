import { getOrCreateUserId } from '../../../lib/session';
import { NextRequest, NextResponse } from 'next/server';
import { generateHmac } from '../../../utils/hmac';
import { env } from 'cloudflare:workers';

export const runtime = 'edge';

async function proxyToBackend(request: NextRequest, method: 'GET' | 'POST') {
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
    let backendPath = '/api/v1/preferences';
    
    let body = '';
    if (method === 'GET') {
      backendPath = `${backendPath}?user_id=${encodeURIComponent(userId)}`;
    } else if (method === 'POST') {
      const json = await request.json();
      body = JSON.stringify({ ...json, user_id: userId });
    }

    const hmacPayload = { method, path: backendPath, timestamp: ts, nonce, body };
    const signature = await generateHmac(hmacPayload, secret);

    const backendReq = new Request(`http://backend${backendPath}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-HMAC-Signature': signature,
        'X-Nonce': nonce,
        'X-Timestamp': String(ts),
      },
      body: method === 'POST' ? body : undefined
    });

    const backendRes = await backend.fetch(backendReq);
    if (!backendRes.ok) {
      const errorText = await backendRes.text();
      return NextResponse.json({ error: `Backend error: ${backendRes.status}`, details: errorText }, { status: backendRes.status });
    }

    const data = await backendRes.json();
    return NextResponse.json(data);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('BFF Error:', message);
    return NextResponse.json({ error: 'Internal Server Error', details: message }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return proxyToBackend(request, 'GET');
}

export async function POST(request: NextRequest) {
  return proxyToBackend(request, 'POST');
}
