import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { route } from '../src/router';
import { createMockEnv, createMockD1Database, createMockKVNamespace, TEST_SECRET } from './setup';
import { buildSignedRequest } from '../src/utils/hmac';
import { computeEventChangeCursor, evaluateEventDelta } from '../src/utils/change-engine';
import type { ApiResponse, PersonalizedFeedResult, SinceLastSeenFeedResult, UserEventRead } from '../src/types';

describe('Phase 11C — Since-Last-Seen Intelligence', () => {
  const baseD1 = createMockD1Database(true);
  const baseKV = createMockKVNamespace();

  function makeEnv() {
    return createMockEnv({
      DB: baseD1,
      CACHE: baseKV,
      HMAC_SECRET: TEST_SECRET,
    });
  }

  async function signedRequest(
    url: string,
    method = 'GET',
    body?: Record<string, unknown>,
    isInternal = false,
    explicitUserId?: string
  ): Promise<Request> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (isInternal) headers['X-Token-ID'] = 'test-token';
    if (explicitUserId) headers['X-Authenticated-User-Id'] = explicitUserId;

    const req = new Request(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const ts = Math.floor(Date.now() / 1000);
    const nonce = `nonce-${ts}-${Math.random().toString(36).substring(2, 9)}`;
    return buildSignedRequest(req, TEST_SECRET, nonce, ts);
  }

  // --------------------------------------------------------------------------
  // 1. Migration Verification
  // --------------------------------------------------------------------------
  describe('Migration 0005 — Schema Integrity & Compatibility', () => {
    it('migration file exists and adheres to SQLite ALTER TABLE non-constant default restriction', () => {
      const migrationPath = join(__dirname, '../../d1/migrations/0005_since_last_seen.sql');
      const content = readFileSync(migrationPath, 'utf8');

      // SQLite ALTER TABLE ADD COLUMN requires constant default (0), then backfill
      expect(content).toContain('ALTER TABLE users');
      expect(content).toContain('ADD COLUMN acknowledged_through INTEGER NOT NULL DEFAULT 0;');
      expect(content).toContain('UPDATE users');
      expect(content).toContain('SET acknowledged_through = unixepoch()');
      expect(content).toContain('WHERE acknowledged_through = 0;');

      // Must NOT contain illegal expression default in ADD COLUMN
      expect(content).not.toMatch(/ADD\s+COLUMN\s+acknowledged_through[^\n]+DEFAULT\s*\([^)]+\)/i);

      // Must create user_event_reads with composite primary key and indexes
      expect(content).toContain('CREATE TABLE IF NOT EXISTS user_event_reads');
      expect(content).toContain('PRIMARY KEY (user_id, event_id)');
      expect(content).toContain('idx_user_event_reads_user');
      expect(content).toContain('idx_user_event_reads_event');
    });

    it('d1/schema.sql includes Phase 11C schema additions', () => {
      const schemaPath = join(__dirname, '../../d1/schema.sql');
      const content = readFileSync(schemaPath, 'utf8');

      expect(content).toContain('acknowledged_through');
      expect(content).toContain('user_event_reads');
      expect(content).toContain('idx_user_event_reads_user');
      expect(content).toContain('idx_user_event_reads_event');
    });
  });

  // --------------------------------------------------------------------------
  // 2. Pure Change Engine Verification
  // --------------------------------------------------------------------------
  describe('Pure Change Engine (computeEventChangeCursor & evaluateEventDelta)', () => {
    it('computes canonical event change cursor as max across all active intelligence signals', () => {
      const cursor = computeEventChangeCursor({
        started_at: 1000,
        last_published_at: 1050,
        brief_updated_at: 1100,
        delta_created_at: 1120,
        claim_created_at: 1110,
      });
      expect(cursor).toBe(1120);
    });

    it('returns null change_type if event change cursor is <= user acknowledged_through', () => {
      const delta = evaluateEventDelta({
        started_at: 1000,
        created_at: 1000,
        last_published_at: 1050,
        article_count: 5,
        source_count: 2,
        brief_version: 2,
        brief_updated_at: 1080,
        delta_created_at: 1090,
        claim_version: 0,
        claim_created_at: null,
        acknowledged_through: 1100,
        articles_before_ack: 5,
        user_read: null,
      });

      expect(delta.change_type).toBeNull();
      expect(delta.is_new).toBe(false);
      expect(delta.has_updates).toBe(false);
      expect(delta.new_article_count).toBe(0);
    });

    it('returns null change_type if user read the event with same or newer version and article count', () => {
      const delta = evaluateEventDelta({
        started_at: 1000,
        created_at: 1000,
        last_published_at: 1050,
        article_count: 5,
        source_count: 2,
        brief_version: 2,
        brief_updated_at: 1080,
        delta_created_at: 1090,
        claim_version: 0,
        claim_created_at: null,
        acknowledged_through: 1000,
        articles_before_ack: 3,
        user_read: {
          user_id: 'u1',
          event_id: 1,
          read_at: 1100,
          seen_article_count: 5,
          seen_brief_version: 2,
          seen_narrative_version: 0,
          seen_claim_version: 0,
        },
      });

      expect(delta.change_type).toBeNull();
      expect(delta.is_new).toBe(false);
      expect(delta.has_updates).toBe(false);
    });

    it('evaluates NEW_EVENT when started_at > acknowledged_through and no user_read', () => {
      const delta = evaluateEventDelta({
        started_at: 1200,
        created_at: 1200,
        last_published_at: 1250,
        article_count: 3,
        source_count: 2,
        brief_version: 1,
        brief_updated_at: 1250,
        delta_created_at: null,
        claim_version: 0,
        claim_created_at: null,
        acknowledged_through: 1100,
        articles_before_ack: 0,
        user_read: null,
      });

      expect(delta.change_type).toBe('NEW_EVENT');
      expect(delta.is_new).toBe(true);
      expect(delta.has_updates).toBe(false);
      expect(delta.new_article_count).toBe(3);
    });

    it('evaluates NARRATIVE_EVOLVED when started_at <= acknowledged_through, but brief_version > seenBriefVersion and brief_updated_at > acknowledged_through', () => {
      const delta = evaluateEventDelta({
        started_at: 1000,
        created_at: 1000,
        last_published_at: 1150,
        article_count: 6,
        source_count: 3,
        brief_version: 2,
        brief_updated_at: 1150,
        delta_created_at: 1150,
        claim_version: 0,
        claim_created_at: null,
        acknowledged_through: 1100,
        articles_before_ack: 4,
        user_read: null,
      });

      expect(delta.change_type).toBe('NARRATIVE_EVOLVED');
      expect(delta.is_new).toBe(false);
      expect(delta.has_updates).toBe(true);
    });

    it('evaluates CROSS_SOURCE_PERSPECTIVE when claim_version > seenClaimVersion and claim_created_at > acknowledged_through with source_count >= 2', () => {
      const delta = evaluateEventDelta({
        started_at: 1000,
        created_at: 1000,
        last_published_at: 1080,
        article_count: 5,
        source_count: 3,
        brief_version: 1,
        brief_updated_at: 1050,
        delta_created_at: null,
        claim_version: 1,
        claim_created_at: 1150,
        acknowledged_through: 1100,
        articles_before_ack: 5,
        user_read: null,
      });

      expect(delta.change_type).toBe('CROSS_SOURCE_PERSPECTIVE');
      expect(delta.is_new).toBe(false);
      expect(delta.has_updates).toBe(true);
    });

    it('evaluates NEW_REPORTING when new articles arrived since baseline and published_at > acknowledged_through', () => {
      const delta = evaluateEventDelta({
        started_at: 1000,
        created_at: 1000,
        last_published_at: 1150,
        article_count: 8,
        source_count: 2,
        brief_version: 1,
        brief_updated_at: 1050,
        delta_created_at: null,
        claim_version: 0,
        claim_created_at: null,
        acknowledged_through: 1100,
        articles_before_ack: 5,
        user_read: null,
      });

      expect(delta.change_type).toBe('NEW_REPORTING');
      expect(delta.is_new).toBe(false);
      expect(delta.has_updates).toBe(true);
      expect(delta.new_article_count).toBe(3);
    });

    it('guarantees non-negative new_article_count even if baseline exceeds current article count', () => {
      const delta = evaluateEventDelta({
        started_at: 1000,
        created_at: 1000,
        last_published_at: 1150,
        article_count: 4,
        source_count: 2,
        brief_version: 1,
        brief_updated_at: 1050,
        delta_created_at: null,
        claim_version: 0,
        claim_created_at: null,
        acknowledged_through: 1100,
        articles_before_ack: 10,
        user_read: null,
      });

      expect(delta.new_article_count).toBe(0);
      expect(delta.change_type).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // 3. First Session Baseline (Zero False Alerts)
  // --------------------------------------------------------------------------
  describe('First-Session Baseline Behavior', () => {
    it('creates brand new user with acknowledged_through = now so old events do not show false NEW', async () => {
      const env = makeEnv();
      const newUserId = `user-first-session-${Date.now()}`;

      const req = await signedRequest('http://localhost/api/v1/feed/for-you', 'GET', undefined, false, newUserId);
      const res = await route(req, env);
      expect(res.status).toBe(200);

      const json = (await res.json()) as ApiResponse<PersonalizedFeedResult>;
      expect(json.success).toBe(true);

      // In mock DB, events have timestamps around 1000, while new user has acknowledged_through = now (~1.7B)
      // Therefore, all events are considered caught up for a first-time user
      expect(json.data!.meta.acknowledged_through).toBeGreaterThan(1000);
      expect(json.data!.meta.unread_event_count).toBe(0);
      expect(json.data!.meta.updated_event_count).toBe(0);
      expect(json.data!.meta.all_caught_up).toBe(true);

      for (const item of json.data!.items) {
        expect(item.since_last_seen).toBeDefined();
        expect(item.since_last_seen!.change_type).toBeNull();
        expect(item.since_last_seen!.is_new).toBe(false);
      }
    });
  });

  // --------------------------------------------------------------------------
  // 4. State Transitions (markFeedCaughtUp & markEventRead)
  // --------------------------------------------------------------------------
  describe('State Transitions & Monotonicity', () => {
    it('POST /api/v1/feed/ack-seen advances acknowledged_through monotonically', async () => {
      const env = makeEnv();
      const userId = 'user-ack-test';

      const req = await signedRequest(
        'http://localhost/api/v1/feed/ack-seen',
        'POST',
        { user_id: userId },
        false,
        userId
      );
      const res = await route(req, env);
      expect(res.status).toBe(200);

      const json = (await res.json()) as ApiResponse<{ acknowledged_through: number }>;
      expect(json.success).toBe(true);
      expect(json.data!.acknowledged_through).toBeGreaterThan(0);

      // Check Cache-Control and Vary headers
      expect(res.headers.get('Cache-Control')).toBe('private, no-cache, no-store, must-revalidate');
      expect(res.headers.get('Vary')).toContain('X-Authenticated-User-Id');
    });

    it('POST /api/v1/feed/read-event records read event idempotently', async () => {
      const env = makeEnv();
      const userId = 'user-read-test';
      const eventId = 1;

      const req = await signedRequest(
        'http://localhost/api/v1/feed/read-event',
        'POST',
        { user_id: userId, event_id: eventId },
        false,
        userId
      );
      const res = await route(req, env);
      expect(res.status).toBe(200);

      const json = (await res.json()) as ApiResponse<UserEventRead>;
      expect(json.success).toBe(true);
      expect(json.data!.event_id).toBe(eventId);
      expect(json.data!.user_id).toBe(userId);
      expect(json.data!.read_at).toBeGreaterThan(0);

      // Repeating read updates read_at idempotently
      const req2 = await signedRequest(
        'http://localhost/api/v1/feed/read-event',
        'POST',
        { user_id: userId, event_id: eventId },
        false,
        userId
      );
      const res2 = await route(req2, env);
      expect(res2.status).toBe(200);
      const json2 = (await res2.json()) as ApiResponse<UserEventRead>;
      expect(json2.success).toBe(true);
    });

    it('rejects invalid event_id in POST /api/v1/feed/read-event', async () => {
      const env = makeEnv();
      const userId = 'user-read-test';

      const req = await signedRequest(
        'http://localhost/api/v1/feed/read-event',
        'POST',
        { user_id: userId, event_id: 'invalid-id' },
        false,
        userId
      );
      const res = await route(req, env);
      expect(res.status).toBe(400);
    });
  });

  // --------------------------------------------------------------------------
  // 5. Security & Identity Boundary Hardening
  // --------------------------------------------------------------------------
  describe('Security & Identity Boundaries', () => {
    it('POST /api/v1/feed/ack-seen rejects missing authentication', async () => {
      const env = makeEnv();
      const req = await signedRequest('http://localhost/api/v1/feed/ack-seen', 'POST', {});
      const res = await route(req, env);
      expect(res.status).toBe(401);
    });

    it('POST /api/v1/feed/ack-seen rejects user_id mismatch with 403', async () => {
      const env = makeEnv();
      const req = await signedRequest(
        'http://localhost/api/v1/feed/ack-seen',
        'POST',
        { user_id: 'attacker-id' },
        false,
        'victim-id'
      );
      const res = await route(req, env);
      expect(res.status).toBe(403);
    });

    it('POST /api/v1/feed/read-event rejects user_id mismatch with 403', async () => {
      const env = makeEnv();
      const req = await signedRequest(
        'http://localhost/api/v1/feed/read-event',
        'POST',
        { user_id: 'attacker-id', event_id: 1 },
        false,
        'victim-id'
      );
      const res = await route(req, env);
      expect(res.status).toBe(403);
    });

    it('GET /api/v1/feed/since-last-seen rejects user_id mismatch with 403', async () => {
      const env = makeEnv();
      const req = await signedRequest(
        'http://localhost/api/v1/feed/since-last-seen?user_id=attacker-id',
        'GET',
        undefined,
        false,
        'victim-id'
      );
      const res = await route(req, env);
      expect(res.status).toBe(403);
    });
  });

  // --------------------------------------------------------------------------
  // 6. Dedicated Catch-Up Stream (GET /api/v1/feed/since-last-seen)
  // --------------------------------------------------------------------------
  describe('GET /api/v1/feed/since-last-seen', () => {
    it('returns dedicated catch-up feed with private headers', async () => {
      const env = makeEnv();
      const userId = 'user-since-last-seen';

      const req = await signedRequest(
        'http://localhost/api/v1/feed/since-last-seen',
        'GET',
        undefined,
        false,
        userId
      );
      const res = await route(req, env);
      expect(res.status).toBe(200);

      expect(res.headers.get('Cache-Control')).toBe('private, no-cache, no-store, must-revalidate');
      expect(res.headers.get('Vary')).toContain('X-Authenticated-User-Id');

      const json = (await res.json()) as ApiResponse<SinceLastSeenFeedResult>;
      expect(json.success).toBe(true);
      expect(json.data!.meta.acknowledged_through).toBeDefined();
      expect(json.data!.meta.total_changed_events).toBeDefined();
      expect(json.data!.meta.all_caught_up).toBeDefined();
      expect(json.data!.items).toBeDefined();
    });
  });
});
