export interface HmacPayload {
  method: string;
  path: string;
  timestamp: number;
  nonce: string;
  body: string;
}

export async function generateHmac(
  payload: HmacPayload,
  secret: string,
  algorithm: string = 'SHA-256'
): Promise<string> {
  const encoder = new TextEncoder();
  const data = `${payload.method}|${payload.path}|${payload.timestamp}|${payload.nonce}|${payload.body}`;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: algorithm },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  const bytes = new Uint8Array(signature);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
