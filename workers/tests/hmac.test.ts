import { describe, it, expect } from 'vitest';
import { generateHmac, verifyHmac, extractHmacPayload, buildSignedRequest } from '../src/utils/hmac';
import { UnauthorizedError } from '../src/utils/errors';
import { createMockEnv, TEST_SECRET } from './setup';

describe('HMAC Utilities', () => {
  const secret = TEST_SECRET;

  describe('generateHmac', () => {
    it('generates consistent hex signature', async () => {
      const payload = { method: 'GET', path: '/api/v1/feed', timestamp: 1234567890, nonce: 'abc123', body: '' };
      const sig1 = await generateHmac(payload, secret);
      const sig2 = await generateHmac(payload, secret);
      expect(sig1).toBe(sig2);
      expect(sig1).toMatch(/^[a-f0-9]{64}$/);
    });

    it('produces different signatures for different payloads', async () => {
      const p1 = { method: 'GET', path: '/api/v1/feed', timestamp: 1, nonce: 'a', body: '' };
      const p2 = { method: 'POST', path: '/api/v1/feed', timestamp: 1, nonce: 'a', body: '' };
      const s1 = await generateHmac(p1, secret);
      const s2 = await generateHmac(p2, secret);
      expect(s1).not.toBe(s2);
    });

    it('produces different signatures for different secrets', async () => {
      const p = { method: 'GET', path: '/api/v1/feed', timestamp: 1, nonce: 'a', body: '' };
      const s1 = await generateHmac(p, 'secret-one');
      const s2 = await generateHmac(p, 'secret-two');
      expect(s1).not.toBe(s2);
    });
  });

  describe('verifyHmac', () => {
    it('verifies valid signature', async () => {
      const payload = { method: 'GET', path: '/api/v1/feed', timestamp: 1, nonce: 'n', body: '' };
      const sig = await generateHmac(payload, secret);
      expect(await verifyHmac(payload, sig, secret)).toBe(true);
    });

    it('rejects invalid signature', async () => {
      const payload = { method: 'GET', path: '/api/v1/feed', timestamp: 1, nonce: 'n', body: '' };
      expect(await verifyHmac(payload, 'bad-sig', secret)).toBe(false);
    });

    it('rejects tampered payload', async () => {
      const payload = { method: 'GET', path: '/api/v1/feed', timestamp: 1, nonce: 'n', body: '' };
      const sig = await generateHmac(payload, secret);
      expect(await verifyHmac({ ...payload, path: '/api/v1/saved' }, sig, secret)).toBe(false);
    });
  });

  describe('extractHmacPayload', () => {
    it('extracts from valid request', async () => {
      const env = createMockEnv();
      const ts = Math.floor(Date.now() / 1000);
      const req = new Request('http://localhost/api/v1/feed', {
        headers: {
          [env.HMAC_HEADER]: 'dummy',
          [env.NONCE_HEADER]: 'nonce-1',
          [env.TIMESTAMP_HEADER]: String(ts),
        },
      });
      const result = await extractHmacPayload(req, env);
      expect(result.signature).toBe('dummy');
      expect(result.payload.timestamp).toBe(ts);
      expect(result.payload.nonce).toBe('nonce-1');
    });

    it('throws on missing headers', async () => {
      const env = createMockEnv();
      await expect(extractHmacPayload(new Request('http://localhost/'), env)).rejects.toThrow(UnauthorizedError);
    });
  });

  describe('buildSignedRequest', () => {
    it('builds a request with valid HMAC headers', async () => {
      const req = new Request('http://localhost/api/v1/feed', { method: 'GET' });
      const signed = await buildSignedRequest(req, secret, 'nonce-1', 1234567890);
      expect(signed.headers.get('X-HMAC-Signature')).toBeTruthy();
      expect(signed.headers.get('X-Nonce')).toBe('nonce-1');
      expect(signed.headers.get('X-Timestamp')).toBe('1234567890');
    });
  });
});
