import { describe, it, expect } from 'vitest';
import {
  scoreEvent,
  compareRankedEvents,
  rankEvents,
  RankingEvent,
  FollowContext,
} from '../src/utils/ranking';

describe('Ranking Engine (Phase 11B)', () => {
  const NOW = 1700000000;

  const baseEvent: RankingEvent = {
    id: 1,
    hash: 'hash-1',
    last_published_at: NOW, // 0 decay
    article_count: 1,
    source_count: 1,
    freshness: 'stale',
    severity: null,
    brief_version: 1,
    has_narrative_delta: false,
    has_claim_comparison: false,
    topic_slugs: [],
    source_names: [],
  };

  const emptyFollows: FollowContext = {
    eventIds: new Set<string>(),
    topicSlugs: new Set<string>(),
    sourceNames: new Set<string>(),
  };

  describe('Direct Event Follow (+120)', () => {
    it('awards +120 and adds reason when event is followed', () => {
      const follows: FollowContext = {
        ...emptyFollows,
        eventIds: new Set(['hash-1']),
      };
      const res = scoreEvent(baseEvent, follows, NOW);
      expect(res.score).toBe(120);
      expect(res.follow_score).toBe(120);
      expect(res.rank_reasons).toContain('Following Event');
    });

    it('awards 0 follow score when event is not in followed set', () => {
      const follows: FollowContext = {
        ...emptyFollows,
        eventIds: new Set(['other-hash']),
      };
      const res = scoreEvent(baseEvent, follows, NOW);
      expect(res.score).toBe(0);
      expect(res.follow_score).toBe(0);
      expect(res.rank_reasons).not.toContain('Following Event');
    });
  });

  describe('Topic Follow (+45 1st, +25 each additional, max +95)', () => {
    it('awards +45 for single matching topic', () => {
      const event: RankingEvent = {
        ...baseEvent,
        topic_slugs: ['ai', 'security'],
      };
      const follows: FollowContext = {
        ...emptyFollows,
        topicSlugs: new Set(['ai']),
      };
      const res = scoreEvent(event, follows, NOW);
      expect(res.score).toBe(45);
      expect(res.follow_score).toBe(45);
      expect(res.rank_reasons).toContain('Topic: ai');
    });

    it('awards +70 for two matching topics (45 + 25)', () => {
      const event: RankingEvent = {
        ...baseEvent,
        topic_slugs: ['ai', 'security'],
      };
      const follows: FollowContext = {
        ...emptyFollows,
        topicSlugs: new Set(['ai', 'security']),
      };
      const res = scoreEvent(event, follows, NOW);
      expect(res.score).toBe(70);
      expect(res.follow_score).toBe(70);
      expect(res.rank_reasons).toContain('Topic: ai');
      expect(res.rank_reasons).toContain('Topic: security');
    });

    it('awards +95 for three matching topics (45 + 25 + 25)', () => {
      const event: RankingEvent = {
        ...baseEvent,
        topic_slugs: ['ai', 'security', 'cloud'],
      };
      const follows: FollowContext = {
        ...emptyFollows,
        topicSlugs: new Set(['ai', 'security', 'cloud']),
      };
      const res = scoreEvent(event, follows, NOW);
      expect(res.score).toBe(95);
      expect(res.follow_score).toBe(95);
    });

    it('caps topic follow points at +95 even with 4 or more matches', () => {
      const event: RankingEvent = {
        ...baseEvent,
        topic_slugs: ['ai', 'security', 'cloud', 'hardware', 'quantum'],
      };
      const follows: FollowContext = {
        ...emptyFollows,
        topicSlugs: new Set(['ai', 'security', 'cloud', 'hardware', 'quantum']),
      };
      const res = scoreEvent(event, follows, NOW);
      expect(res.score).toBe(95);
      expect(res.follow_score).toBe(95);
      // Reasons display capped to 2
      const topicReasons = res.rank_reasons.filter(r => r.startsWith('Topic:'));
      expect(topicReasons.length).toBe(2);
    });
  });

  describe('Source Follow (+20 per match, max +40)', () => {
    it('awards +20 for single matching source', () => {
      const event: RankingEvent = {
        ...baseEvent,
        source_names: ['Reuters', 'BBC'],
      };
      const follows: FollowContext = {
        ...emptyFollows,
        sourceNames: new Set(['reuters']),
      };
      const res = scoreEvent(event, follows, NOW);
      expect(res.score).toBe(20);
      expect(res.follow_score).toBe(20);
      expect(res.rank_reasons).toContain('Source: Reuters');
    });

    it('awards +40 for two matching sources', () => {
      const event: RankingEvent = {
        ...baseEvent,
        source_names: ['Reuters', 'BBC'],
      };
      const follows: FollowContext = {
        ...emptyFollows,
        sourceNames: new Set(['reuters', 'bbc']),
      };
      const res = scoreEvent(event, follows, NOW);
      expect(res.score).toBe(40);
      expect(res.follow_score).toBe(40);
      expect(res.rank_reasons).toContain('Source: Reuters');
      expect(res.rank_reasons).toContain('Source: BBC');
    });

    it('caps source points at +40 with 3 or more matching sources', () => {
      const event: RankingEvent = {
        ...baseEvent,
        source_names: ['Reuters', 'BBC', 'Bloomberg', 'TechCrunch'],
      };
      const follows: FollowContext = {
        ...emptyFollows,
        sourceNames: new Set(['reuters', 'bbc', 'bloomberg', 'techcrunch']),
      };
      const res = scoreEvent(event, follows, NOW);
      expect(res.score).toBe(40);
      expect(res.follow_score).toBe(40);
      const sourceReasons = res.rank_reasons.filter(r => r.startsWith('Source:'));
      expect(sourceReasons.length).toBe(2);
    });
  });

  describe('Narrative Evolution (+35)', () => {
    it('awards +35 when has_narrative_delta is true', () => {
      const event: RankingEvent = {
        ...baseEvent,
        has_narrative_delta: true,
        brief_version: 1,
      };
      const res = scoreEvent(event, emptyFollows, NOW);
      expect(res.score).toBe(35);
      expect(res.rank_reasons).toContain('Narrative Evolved (V2+)');
    });

    it('awards +35 when brief_version is >= 2', () => {
      const event: RankingEvent = {
        ...baseEvent,
        brief_version: 3,
        has_narrative_delta: false,
      };
      const res = scoreEvent(event, emptyFollows, NOW);
      expect(res.score).toBe(35);
      expect(res.rank_reasons).toContain('Narrative Evolved (V3)');
    });

    it('does not award +35 twice when both has_narrative_delta and brief_version >= 2 are true', () => {
      const event: RankingEvent = {
        ...baseEvent,
        brief_version: 2,
        has_narrative_delta: true,
      };
      const res = scoreEvent(event, emptyFollows, NOW);
      expect(res.score).toBe(35);
      expect(res.rank_reasons).toContain('Narrative Evolved (V2)');
    });
  });

  describe('Cross-Source Perspectives (+25)', () => {
    it('awards +25 when has_claim_comparison is true and source_count >= 2', () => {
      const event: RankingEvent = {
        ...baseEvent,
        has_claim_comparison: true,
        source_count: 2,
      };
      // Note: source_count 2 also awards +10 coverage
      const res = scoreEvent(event, emptyFollows, NOW);
      expect(res.score).toBe(35); // 25 + 10
      expect(res.rank_reasons).toContain('Cross-Source Perspectives');
    });

    it('does not award +25 if source_count is less than 2', () => {
      const event: RankingEvent = {
        ...baseEvent,
        has_claim_comparison: true,
        source_count: 1,
      };
      const res = scoreEvent(event, emptyFollows, NOW);
      expect(res.score).toBe(0);
      expect(res.rank_reasons).not.toContain('Cross-Source Perspectives');
    });
  });

  describe('Freshness (+30 developing, +15 active, 0 stale)', () => {
    it('awards +30 for developing', () => {
      const event: RankingEvent = {
        ...baseEvent,
        freshness: 'developing',
      };
      const res = scoreEvent(event, emptyFollows, NOW);
      expect(res.score).toBe(30);
      expect(res.rank_reasons).toContain('Developing Story');
    });

    it('awards +15 for active', () => {
      const event: RankingEvent = {
        ...baseEvent,
        freshness: 'active',
      };
      const res = scoreEvent(event, emptyFollows, NOW);
      expect(res.score).toBe(15);
    });

    it('awards 0 for stale', () => {
      const event: RankingEvent = {
        ...baseEvent,
        freshness: 'stale',
      };
      const res = scoreEvent(event, emptyFollows, NOW);
      expect(res.score).toBe(0);
    });
  });

  describe('Coverage (+20 for 3+, +10 for 2, 0 for <=1)', () => {
    it('awards +20 and reason for 3 or more sources', () => {
      const event: RankingEvent = {
        ...baseEvent,
        source_count: 4,
      };
      const res = scoreEvent(event, emptyFollows, NOW);
      expect(res.score).toBe(20);
      expect(res.rank_reasons).toContain('Broad Multi-Source Coverage');
    });

    it('awards +10 for exactly 2 sources', () => {
      const event: RankingEvent = {
        ...baseEvent,
        source_count: 2,
      };
      const res = scoreEvent(event, emptyFollows, NOW);
      expect(res.score).toBe(10);
      expect(res.rank_reasons).not.toContain('Broad Multi-Source Coverage');
    });

    it('awards 0 for 1 or fewer sources', () => {
      const event: RankingEvent = {
        ...baseEvent,
        source_count: 1,
      };
      const res = scoreEvent(event, emptyFollows, NOW);
      expect(res.score).toBe(0);
    });
  });

  describe('Severity (+15 critical, +10 warning/high, 0 other)', () => {
    it('awards +15 for critical', () => {
      const event: RankingEvent = {
        ...baseEvent,
        severity: 'critical',
      };
      const res = scoreEvent(event, emptyFollows, NOW);
      expect(res.score).toBe(15);
      expect(res.rank_reasons).toContain('High Severity Alert');
    });

    it('awards +10 for warning', () => {
      const event: RankingEvent = {
        ...baseEvent,
        severity: 'warning',
      };
      const res = scoreEvent(event, emptyFollows, NOW);
      expect(res.score).toBe(10);
      expect(res.rank_reasons).toContain('High Severity Alert');
    });

    it('awards +10 for high', () => {
      const event: RankingEvent = {
        ...baseEvent,
        severity: 'high',
      };
      const res = scoreEvent(event, emptyFollows, NOW);
      expect(res.score).toBe(10);
      expect(res.rank_reasons).toContain('High Severity Alert');
    });

    it('awards 0 for info / medium / low', () => {
      for (const sev of ['info', 'medium', 'low']) {
        const event: RankingEvent = {
          ...baseEvent,
          severity: sev,
        };
        const res = scoreEvent(event, emptyFollows, NOW);
        expect(res.score).toBe(0);
        expect(res.rank_reasons).not.toContain('High Severity Alert');
      }
    });
  });

  describe('Time Decay & Bounds (-1.5 per 12h, max 30)', () => {
    it('applies 0 decay when published now', () => {
      const event: RankingEvent = {
        ...baseEvent,
        freshness: 'developing', // +30
        last_published_at: NOW,
      };
      const res = scoreEvent(event, emptyFollows, NOW);
      expect(res.score).toBe(30);
    });

    it('applies -1.5 decay after 12 hours', () => {
      const event: RankingEvent = {
        ...baseEvent,
        freshness: 'developing', // +30
        last_published_at: NOW - 43200,
      };
      const res = scoreEvent(event, emptyFollows, NOW);
      expect(res.score).toBe(28.5);
    });

    it('applies -3.0 decay after 24 hours', () => {
      const event: RankingEvent = {
        ...baseEvent,
        freshness: 'developing', // +30
        last_published_at: NOW - 86400,
      };
      const res = scoreEvent(event, emptyFollows, NOW);
      expect(res.score).toBe(27);
    });

    it('caps decay at -30 points after 240+ hours (10 days)', () => {
      const event: RankingEvent = {
        ...baseEvent,
        severity: 'critical', // +15
        freshness: 'active', // +15
        source_count: 3, // +20
        // Total positive = 50
        last_published_at: NOW - (30 * 86400), // 30 days ago -> 60 intervals * 1.5 = 90, capped at 30
      };
      const res = scoreEvent(event, emptyFollows, NOW);
      expect(res.score).toBe(20); // 50 - 30 = 20
    });

    it('never allows score to drop below 0 (score floor)', () => {
      const event: RankingEvent = {
        ...baseEvent,
        severity: 'info', // 0
        freshness: 'stale', // 0
        last_published_at: NOW - (5 * 86400), // decay would be 15
      };
      const res = scoreEvent(event, emptyFollows, NOW);
      expect(res.score).toBe(0);
    });

    it('handles null last_published_at safely without decay', () => {
      const event: RankingEvent = {
        ...baseEvent,
        freshness: 'active', // +15
        last_published_at: null,
      };
      const res = scoreEvent(event, emptyFollows, NOW);
      expect(res.score).toBe(15);
    });
  });

  describe('Fallback Reason (Top Active Story)', () => {
    it('emits Top Active Story when no reasons emitted and event is active', () => {
      const event: RankingEvent = {
        ...baseEvent,
        freshness: 'active', // +15, but no badge assigned for active alone
        severity: 'info',
        source_count: 1,
      };
      const res = scoreEvent(event, emptyFollows, NOW);
      expect(res.score).toBe(15);
      expect(res.rank_reasons).toEqual(['Top Active Story']);
    });

    it('does not emit Top Active Story when event is stale and has no score', () => {
      const event: RankingEvent = {
        ...baseEvent,
        freshness: 'stale',
      };
      const res = scoreEvent(event, emptyFollows, NOW);
      expect(res.score).toBe(0);
      expect(res.rank_reasons).toEqual([]);
    });
  });

  describe('Full Composite & Tie-Breaking', () => {
    it('computes exact composite score for an evolved, developing, followed event', () => {
      // Event:
      // Direct follow: +120
      // Topic match: +45
      // Source match: +20
      // Narrative delta: +35
      // Claim comparison (3 sources): +25
      // Developing freshness: +30
      // 3 sources coverage: +20
      // Warning severity: +10
      // Total positive: 305
      // Elapsed 12 hours: -1.5
      // Final: 303.5
      const event: RankingEvent = {
        id: 10,
        hash: 'ev-top',
        last_published_at: NOW - 43200,
        article_count: 8,
        source_count: 3,
        freshness: 'developing',
        severity: 'warning',
        brief_version: 2,
        has_narrative_delta: true,
        has_claim_comparison: true,
        topic_slugs: ['ai'],
        source_names: ['Reuters'],
      };
      const follows: FollowContext = {
        eventIds: new Set(['ev-top']),
        topicSlugs: new Set(['ai']),
        sourceNames: new Set(['reuters']),
      };
      const res = scoreEvent(event, follows, NOW);
      expect(res.score).toBe(303.5);
      expect(res.follow_score).toBe(185); // 120 + 45 + 20
      expect(res.rank_reasons).toEqual([
        'Following Event',
        'Topic: ai',
        'Source: Reuters',
        'Narrative Evolved (V2)',
        'Cross-Source Perspectives',
        'Developing Story',
        'Broad Multi-Source Coverage',
        'High Severity Alert',
      ]);
    });

    it('breaks ties deterministically in rankEvents', () => {
      // 3 events with identical score
      const ev1: RankingEvent = {
        ...baseEvent,
        id: 1,
        hash: 'ev-1',
        freshness: 'active', // score 15
        last_published_at: NOW - 1000,
        article_count: 5,
      };
      const ev2: RankingEvent = {
        ...baseEvent,
        id: 2,
        hash: 'ev-2',
        freshness: 'active', // score 15
        last_published_at: NOW - 500, // newer published -> should be first
        article_count: 3,
      };
      const ev3: RankingEvent = {
        ...baseEvent,
        id: 3,
        hash: 'ev-3',
        freshness: 'active', // score 15
        last_published_at: NOW - 1000, // same published as ev1, but more articles -> should beat ev1
        article_count: 10,
      };

      const ranked = rankEvents([ev1, ev2, ev3], emptyFollows, NOW);
      expect(ranked.map(r => r.event.id)).toEqual([2, 3, 1]);
    });

    it('directly tests compareRankedEvents comparator', () => {
      const a = {
        event: { ...baseEvent, id: 1, last_published_at: 100, article_count: 2 },
        score: 10,
        rank_reasons: [],
        follow_score: 0,
      };
      const b = {
        event: { ...baseEvent, id: 2, last_published_at: 100, article_count: 2 },
        score: 20,
        rank_reasons: [],
        follow_score: 0,
      };
      // b has higher score, so compareRankedEvents(a, b) should be positive (b comes before a)
      expect(compareRankedEvents(a, b)).toBeGreaterThan(0);
      expect(compareRankedEvents(b, a)).toBeLessThan(0);
    });
  });
});
