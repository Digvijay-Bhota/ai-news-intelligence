import { describe, it, expect } from 'vitest';
import { getClientIp, checkPublicRateLimit, checkInternalRateLimit } from '../src/utils/rate-limiter';
import { RateLimitError } from '../src/utils/errors';
import { createMockEnv, createMockD1Database } from './setup';

describe('Rate Limiter', () => {
  describe('getClientIp', () => {
    it('extracts CF-Connecting-IP', () => {
      const req = new Request('http://localhost/', {
        headers: { 'CF-Connecting-IP': '1.2.3.4' },
      });
      expect(getClientIp(req)).toBe('1.2.3.4');
    });

    it('falls back to X-Forwarded-For', () => {
      const req = new Request('http://localhost/', {
        headers: { 'X-Forwarded-For': '5.6.7.8, 9.10.11.12' },
      });
      expect(getClientIp(req)).toBe('5.6.7.8');
    });

    it('returns unknown when no headers', () => {
      const req = new Request('http://localhost/');
      expect(getClientIp(req)).toBe('unknown');
    });
  });

  describe('checkPublicRateLimit', () => {
    it('allows requests within limit', async () => {
      const env = createMockEnv({ DB: createMockD1Database() });
      const req = new Request('http://localhost/', { headers: { 'CF-Connecting-IP': '1.2.3.4' } });
      const result = await checkPublicRateLimit(req, '/api/v1/feed', env);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeGreaterThanOrEqual(0);
    });
  });

  describe('checkInternalRateLimit', () => {
    it('allows requests within limit', async () => {
      const env = createMockEnv({ DB: createMockD1Database() });
      const result = await checkInternalRateLimit('token-1', '/internal/v1/articles', env);
      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(1000);
    });
  });
});
