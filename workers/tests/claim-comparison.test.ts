/**
 * claim-comparison.test.ts — Phase 10: Cross-Source Disagreement Tests
 *
 * Tests schema validation, provenance enforcement, and referential integrity
 * for the Cross-Source Claim Comparison Engine.
 */

import { describe, it, expect } from 'vitest';
import { validateClaimComparisons } from '../src/tasks/claim-comparison-generator';
import claimComparison04 from './gemini-quality-eval/cases/claim-comparison-04-evolving-breaking-situation.json';

const makeValidClaim = (articleIds: number[], sourceIds: number[]) => [
  {
    claim: 'The merger will close in Q4 2026.',
    status: 'disputed',
    sources: [
      {
        source_id: sourceIds[0],
        source_name: 'Financial Times',
        position: 'Reports expected closing in October.',
        article_ids: [articleIds[0]],
      },
      {
        source_id: sourceIds[1] ?? sourceIds[0],
        source_name: 'Reuters',
        position: 'Cites regulatory delays extending timeline to 2027.',
        article_ids: [articleIds[1] ?? articleIds[0]],
      },
    ],
  },
];

/** Article 1 was published by source 1 (used by the single-article tests below). */
const ONE_TO_ONE: ReadonlyMap<number, number> = new Map([[1, 1]]);

describe('validateClaimComparisons', () => {
  it('accepts valid cross-source claim comparisons', () => {
    const validArticles = new Set([101, 102]);
    const validSources = new Set([1, 2]);
    const raw = makeValidClaim([101, 102], [1, 2]);

    expect(() => validateClaimComparisons(raw, validArticles, validSources, new Map([[101, 1], [102, 2]]))).not.toThrow();
  });

  it('rejects non-array input', () => {
    const validArticles = new Set([1]);
    const validSources = new Set([1]);
    expect(() => validateClaimComparisons('not an array', validArticles, validSources, ONE_TO_ONE)).toThrow('expected an array');
    expect(() => validateClaimComparisons({}, validArticles, validSources, ONE_TO_ONE)).toThrow('expected an array');
  });

  it('rejects claim with text too short', () => {
    const validArticles = new Set([1]);
    const validSources = new Set([1]);
    const raw = [
      {
        claim: 'Hi',
        status: 'consensus',
        sources: [
          { source_id: 1, source_name: 'Source 1', position: 'Position', article_ids: [1] },
        ],
      },
    ];
    expect(() => validateClaimComparisons(raw, validArticles, validSources, ONE_TO_ONE)).toThrow('between 5 and 500 characters');
  });

  it('rejects invalid or missing status values', () => {
    const validArticles = new Set([1]);
    const validSources = new Set([1]);
    const invalidStatuses = ['probably_consensus', 'false', '', null, undefined, 'non_existent_status'];
    for (const badStatus of invalidStatuses) {
      const raw = [
        {
          claim: 'Valid claim text here.',
          status: badStatus,
          sources: [
            { source_id: 1, source_name: 'Source 1', position: 'Position', article_ids: [1] },
          ],
        },
      ];
      expect(() => validateClaimComparisons(raw, validArticles, validSources, ONE_TO_ONE)).toThrow(/Invalid claim status/);
    }
  });

  it('enforces referential integrity: rejects invalid source_id not in validSourceIds', () => {
    const validArticles = new Set([1]);
    const validSources = new Set([1]);
    const raw = [
      {
        claim: 'Valid claim statement.',
        status: 'consensus',
        sources: [
          { source_id: 99, source_name: 'Fake Newsroom', position: 'Some statement', article_ids: [1] },
        ],
      },
    ];
    expect(() => validateClaimComparisons(raw, validArticles, validSources, ONE_TO_ONE)).toThrow(
      'Referential violation: source_id 99 at claim[0] is not in the event source set'
    );
  });

  it('enforces grounding: rejects invalid article_id not in validArticleIds', () => {
    const validArticles = new Set([1]);
    const validSources = new Set([1]);
    const raw = [
      {
        claim: 'Valid claim statement.',
        status: 'consensus',
        sources: [
          { source_id: 1, source_name: 'Newsroom 1', position: 'Some statement', article_ids: [999] },
        ],
      },
    ];
    expect(() => validateClaimComparisons(raw, validArticles, validSources, ONE_TO_ONE)).toThrow(
      'Grounding violation: article_id 999 at claim[0].sources[0] is not in the event article set'
    );
  });

  it('deduplicates article_ids within a source attribution', () => {
    const validArticles = new Set([1]);
    const validSources = new Set([1]);
    const raw = [
      {
        claim: 'Valid claim statement.',
        status: 'consensus',
        sources: [
          { source_id: 1, source_name: 'Newsroom 1', position: 'Some statement', article_ids: [1, 1, 1] },
        ],
      },
    ];
    expect(() => validateClaimComparisons(raw, validArticles, validSources, ONE_TO_ONE)).not.toThrow();
    expect(raw[0].sources[0].article_ids).toEqual([1]);
  });
});

// ─── Source attribution regression (offline Gemini evaluation, claim-comparison-04) ───
// Articles 111 and 112 were published by source 111; article 113 by source 112.
// Article IDs and source IDs are separate numbering spaces that overlap here.

describe('validateClaimComparisons: source_id must own every cited article', () => {
  const articles = claimComparison04.articles;
  const validArticles = new Set(articles.map((a) => a.id));
  const validSources = new Set(articles.map((a) => a.source_id));
  const owners = new Map(articles.map((a) => [a.id, a.source_id] as const));
  const validate = (raw: unknown) => validateClaimComparisons(raw, validArticles, validSources, owners);

  const src = (source_id: number, source_name: string, article_ids: number[]) => ({
    source_id,
    source_name,
    position: 'Reported the stated figures for the Cedar Ridge fire.',
    article_ids,
  });
  const claim = (status: string, sources: ReturnType<typeof src>[]) => [
    { claim: 'The Cedar Ridge fire grew and containment fell during the day.', status, sources },
  ];

  it('fixture sanity: articles 111 and 112 belong to source 111, article 113 to source 112', () => {
    expect([...owners]).toEqual([[111, 111], [112, 111], [113, 112]]);
  });

  it('accepts the correct mapping, including several articles under one source', () => {
    expect(() =>
      validate(claim('evolving', [src(111, 'Wildfire Response Network', [111, 112]), src(112, 'Regional Emergency Alerts', [113])]))
    ).not.toThrow();
  });

  it('rejects an article ID used as the source_id (article 112 under source_id 112)', () => {
    expect(() => validate(claim('evolving', [src(112, 'Wildfire Response Network', [112])]))).toThrow(
      'Referential violation: article_id 112 at claim[0].sources[0] belongs to source_id 111, not source_id 112'
    );
  });

  it('rejects a source entry that mixes articles from different sources', () => {
    expect(() => validate(claim('consensus', [src(111, 'Wildfire Response Network', [111, 113])]))).toThrow(
      'Referential violation: article_id 113 at claim[0].sources[0] belongs to source_id 112, not source_id 111'
    );
  });

  it('rejects unknown source IDs and unknown article IDs', () => {
    expect(() => validate(claim('consensus', [src(113, 'Regional Emergency Alerts', [113])]))).toThrow(
      'Referential violation: source_id 113 at claim[0] is not in the event source set'
    );
    expect(() => validate(claim('consensus', [src(111, 'Wildfire Response Network', [999])]))).toThrow(
      'Grounding violation: article_id 999 at claim[0].sources[0] is not in the event article set'
    );
  });

  it('fails closed when a cited article has no known source in the ownership map', () => {
    expect(() =>
      validateClaimComparisons(claim('consensus', [src(111, 'Wildfire Response Network', [111])]), validArticles, validSources, new Map())
    ).toThrow('Referential violation: article_id 111 at claim[0].sources[0] has no known source');
  });

  it('now rejects the recorded Gemini 3.5 Flash-Lite output at its first misattribution (previously missed)', () => {
    // Exact content of the rejected artifact recorded during the offline evaluation.
    const recorded = [
      {
        claim: 'The size and containment percentage of the wildfire near Cedar Ridge changed throughout the day.',
        status: 'evolving',
        sources: [
          { source_id: 111, source_name: 'Wildfire Response Network', position: 'Reported an early-morning fire size of 2,000 acres with 10% containment.', article_ids: [111] },
          { source_id: 112, source_name: 'Wildfire Response Network', position: 'Reported an afternoon update stating the fire grew to 5,500 acres with containment dropping to 5%.', article_ids: [112] },
        ],
      },
      {
        claim: 'An evacuation zone has been expanded as the fire continues to grow.',
        status: 'consensus',
        sources: [
          { source_id: 112, source_name: 'Wildfire Response Network', position: 'Mentioned an expanded evacuation zone in the afternoon update.', article_ids: [112] },
          { source_id: 113, source_name: 'Regional Emergency Alerts', position: 'Confirmed and corroborated the expanded evacuation zone described in the afternoon update.', article_ids: [113] },
        ],
      },
    ];
    // The old validator only caught source_id 113 in claim[1]; claim[0]'s wrong source_id 112 slipped through.
    expect(() => validate(recorded)).toThrow(
      'Referential violation: article_id 112 at claim[0].sources[1] belongs to source_id 111, not source_id 112'
    );
  });

  it('rejects ordinal source IDs like the recorded Gemini 3.6 Flash output', () => {
    expect(() => validate(claim('evolving', [src(1, 'Wildfire Response Network', [111, 112])]))).toThrow(
      'Referential violation: source_id 1 at claim[0] is not in the event source set'
    );
  });

  // A source entry that cites no article cannot have its source_id verified, so it must
  // be rejected — otherwise e.g. source_id 112 could be labelled "Wildfire Response Network".
  const ARTICLE_IDS_ERROR = 'Invalid article_ids at claim[0].sources[0]: article_ids must be a non-empty array';
  const misattributedEntry = {
    source_id: 112,
    source_name: 'Wildfire Response Network',
    position: 'Reported the expanded evacuation zone.',
  };

  it('rejects a source entry with missing article_ids', () => {
    expect(() => validate(claim('consensus', [misattributedEntry as never]))).toThrow(ARTICLE_IDS_ERROR);
  });

  it('rejects a source entry with empty article_ids', () => {
    expect(() => validate(claim('consensus', [{ ...misattributedEntry, article_ids: [] }]))).toThrow(ARTICLE_IDS_ERROR);
  });

  it('rejects article_ids that are not an array', () => {
    for (const notAnArray of [null, 112, '112', { 0: 112 }]) {
      expect(() => validate(claim('consensus', [{ ...misattributedEntry, article_ids: notAnArray as never }]))).toThrow(
        ARTICLE_IDS_ERROR
      );
    }
  });

  it('rejects an empty article_ids entry even when other source entries in the claim are valid', () => {
    expect(() =>
      validate(claim('consensus', [src(111, 'Wildfire Response Network', [112]), { ...misattributedEntry, article_ids: [] }]))
    ).toThrow('Invalid article_ids at claim[0].sources[1]: article_ids must be a non-empty array');
  });
});
