import { NextRequest, NextResponse } from 'next/server';
import { generateHmac } from '../../../../utils/hmac';
import { env } from 'cloudflare:workers';
import { getOrCreateUserId } from '../../../../lib/session';

export const runtime = 'edge';

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const userId = await getOrCreateUserId(request);
    const id = params.id;

    if (!id) {
      return NextResponse.json({ error: 'id required' }, { status: 400 });
    }

    const secret = env.HMAC_SECRET;
    if (!secret) return NextResponse.json({ error: 'Missing HMAC_SECRET' }, { status: 500 });

    const backend = env.BACKEND_API;
    if (!backend || typeof backend.fetch !== 'function') return NextResponse.json({ error: 'Missing BACKEND_API binding' }, { status: 500 });

    const ts = Math.floor(Date.now() / 1000);
    const nonce = `nonce-${ts}-${Math.random().toString(36).substring(2, 9)}`;

    // Backend expects user_id in query params for DELETE
    const backendPath = `/api/v1/saved/${id}`;
    const fullPath = `${backendPath}?user_id=${encodeURIComponent(userId)}`;

    const hmacPayload = {
      method: 'DELETE',
      path: fullPath,
      timestamp: ts,
      nonce,
      body: '',
    };

    const signature = await generateHmac(hmacPayload, secret);

    const backendReq = new Request(`http://backend${fullPath}`, {
      method: 'DELETE',
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
    console.error('BFF DELETE /saved/:id Error:', message);
    return NextResponse.json({ error: 'Internal Server Error', details: message }, { status: 500 });
  }
}
