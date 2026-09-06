import { NextRequest, NextResponse } from 'next/server';

export function getClientIpHeaders(request: NextRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  const connectingIp = request.headers.get('cf-connecting-ip');
  const forwardedFor = request.headers.get('x-forwarded-for');

  if (connectingIp) {
    headers['cf-connecting-ip'] = connectingIp;
  } else if (forwardedFor) {
    headers['x-forwarded-for'] = forwardedFor;
  }

  return headers;
}

export function withRateLimitHeaders(response: NextResponse, backendRes: Response): NextResponse {
  backendRes.headers.forEach((value, key) => {
    if (key.toLowerCase().startsWith('x-ratelimit-')) {
      response.headers.set(key, value);
    }
  });
  return response;
}
