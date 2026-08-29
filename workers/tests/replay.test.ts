import { describe, it, expect, beforeEach } from 'vitest';
import { validateTimestamp, checkReplayProtection } from '../src/utils/replay';
import { UnauthorizedError } from '../src/utils/errors';
import { createMockEnv, createMockD1Database } from './setup';

describe('Replay Protection', () => {
  let env: ReturnType<typeof createMockEnv>;

  beforeEach(() => {
    env = createMockEnv({ DB: createMockD1Database() });
  });

  describe('validateTimestamp', () => {
    it('accepts timestamp within window', () => {
      const now = Math.floor(Date.now() / 1000);
      expect(() => validateTimestamp(now, env)).not.toThrow();
    });

    it('rejects old timestamp', () => {
      const old = Math.floor(Date.now() / 1000) - 1000;
      expect(() => validateTimestamp(old, env)).toThrow(UnauthorizedError);
    });

    it('rejects future timestamp', () => {
      const future = Math.floor(Date.now() / 1000) + 1000;
      expect(() => validateTimestamp(future, env)).toThrow(UnauthorizedError);
    });
  });

  describe('checkReplayProtection', () => {
    it('passes for fresh nonce', async () => {
      const now = Math.floor(Date.now() / 1000);
      await expect(checkReplayProtection('fresh-nonce', now, 'id', '/int', 'POST', env)).resolves.toBeUndefined();
    });

    it('throws for expired timestamp', async () => {
      const old = Math.floor(Date.now() / 1000) - 1000;
      await expect(checkReplayProtection('n', old, 'id', '/int', 'POST', env)).rejects.toThrow(UnauthorizedError);
    });
  });
});
