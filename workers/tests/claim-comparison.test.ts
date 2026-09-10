/**
 * claim-comparison.test.ts — Phase 10: Cross-Source Disagreement Tests
 *
 * Tests schema validation, provenance enforcement, and referential integrity
 * for the Cross-Source Claim Comparison Engine.
 */

import { describe, it, expect } from 'vitest';
import { validateClaimComparisons } from '../src/tasks/claim-comparison-generator';

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

describe('validateClaimComparisons', () => {
  it('accepts valid cross-source claim comparisons', () => {
    const validArticles = new Set([101, 102]);
    const validSources = new Set([1, 2]);
    const raw = makeValidClaim([101, 102], [1, 2]);

    expect(() => validateClaimComparisons(raw, validArticles, validSources)).not.toThrow();
  });

  it('rejects non-array input', () => {
    const validArticles = new Set([1]);
    const validSources = new Set([1]);
    expect(() => validateClaimComparisons('not an array', validArticles, validSources)).toThrow('expected an array');
    expect(() => validateClaimComparisons({}, validArticles, validSources)).toThrow('expected an array');
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
    expect(() => validateClaimComparisons(raw, validArticles, validSources)).toThrow('between 5 and 500 characters');
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
      expect(() => validateClaimComparisons(raw, validArticles, validSources)).toThrow(/Invalid claim status/);
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
    expect(() => validateClaimComparisons(raw, validArticles, validSources)).toThrow(
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
    expect(() => validateClaimComparisons(raw, validArticles, validSources)).toThrow(
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
    expect(() => validateClaimComparisons(raw, validArticles, validSources)).not.toThrow();
    expect(raw[0].sources[0].article_ids).toEqual([1]);
  });
});
