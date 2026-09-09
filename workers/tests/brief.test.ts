/**
 * brief.test.ts — Phase 9: Grounded AI Event Briefing & Change Detection
 *
 * Tests contract validation, fingerprinting, provenance grounding, and regeneration logic.
 */

import { describe, it, expect } from 'vitest';
import { computeArticleFingerprint, validateEventBrief } from '../src/tasks/brief-generator';

// ─── Helpers ────────────────────────────────────────────────────────────────

const makeArticle = (id: number, opts?: Partial<{
  published_at: number | null;
  source_id: number;
  title: string;
  summary?: string | null;
  raw_content?: string | null;
}>) => ({
  id,
  published_at: opts?.published_at ?? 1000 + id,
  source_id: opts?.source_id ?? 1,
  title: opts?.title ?? `Article ${id}`,
  summary: opts?.summary ?? null,
  raw_content: opts?.raw_content ?? null,
});

const makeValidBrief = (articleIds: number[]): unknown => ({
  summary: 'A summary of the event that is at least twenty characters long.',
  why_it_matters: 'This matters because it sets a precedent.',
  key_developments: ['First development noted by reporters.'],
  key_entities: [
    { name: 'Example Corp', type: 'organization', relevance: 'Central actor in the story.' },
  ],
  uncertainties: ['The final outcome has not been confirmed.'],
  source_references: articleIds.map((id) => ({
    article_id: id,
    claim_context: `This article provided the key claim for article ${id}.`,
  })),
});

// ─── Fingerprinting ──────────────────────────────────────────────────────────

describe('computeArticleFingerprint', () => {
  it('produces a deterministic hex string', async () => {
    const articles = [makeArticle(1), makeArticle(2)];
    const fp = await computeArticleFingerprint(10, articles);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable: same article set → same fingerprint', async () => {
    const articles = [makeArticle(1), makeArticle(2), makeArticle(3)];
    const fp1 = await computeArticleFingerprint(7, articles);
    const fp2 = await computeArticleFingerprint(7, [...articles].reverse());
    expect(fp1).toBe(fp2);
  });

  it('changes when a new article is added', async () => {
    const base = [makeArticle(1), makeArticle(2)];
    const extended = [...base, makeArticle(3)];
    const fp1 = await computeArticleFingerprint(7, base);
    const fp2 = await computeArticleFingerprint(7, extended);
    expect(fp1).not.toBe(fp2);
  });

  it('changes when published_at changes', async () => {
    const v1 = [makeArticle(1, { published_at: 1000 })];
    const v2 = [makeArticle(1, { published_at: 9999 })];
    const fp1 = await computeArticleFingerprint(7, v1);
    const fp2 = await computeArticleFingerprint(7, v2);
    expect(fp1).not.toBe(fp2);
  });

  it('changes when source_id changes', async () => {
    const v1 = [makeArticle(1, { source_id: 1 })];
    const v2 = [makeArticle(1, { source_id: 2 })];
    const fp1 = await computeArticleFingerprint(7, v1);
    const fp2 = await computeArticleFingerprint(7, v2);
    expect(fp1).not.toBe(fp2);
  });

  it('changes when article title changes', async () => {
    const v1 = [makeArticle(1, { title: 'Old Title' })];
    const v2 = [makeArticle(1, { title: 'New Title' })];
    const fp1 = await computeArticleFingerprint(7, v1);
    const fp2 = await computeArticleFingerprint(7, v2);
    expect(fp1).not.toBe(fp2);
  });

  it('changes for different event IDs with same articles', async () => {
    const articles = [makeArticle(1)];
    const fp1 = await computeArticleFingerprint(1, articles);
    const fp2 = await computeArticleFingerprint(2, articles);
    expect(fp1).not.toBe(fp2);
  });

  it('changes when article summary changes', async () => {
    const v1 = [makeArticle(1, { summary: 'Old summary text' } as any)];
    const v2 = [makeArticle(1, { summary: 'Updated summary text with new facts' } as any)];
    const fp1 = await computeArticleFingerprint(7, v1);
    const fp2 = await computeArticleFingerprint(7, v2);
    expect(fp1).not.toBe(fp2);
  });

  it('changes when article raw_content changes', async () => {
    const v1 = [makeArticle(1, { raw_content: 'Original full article text' } as any)];
    const v2 = [makeArticle(1, { raw_content: 'Revised full article text with corrections' } as any)];
    const fp1 = await computeArticleFingerprint(7, v1);
    const fp2 = await computeArticleFingerprint(7, v2);
    expect(fp1).not.toBe(fp2);
  });

  it('handles null published_at', async () => {
    const articles = [makeArticle(1, { published_at: null })];
    const fp = await computeArticleFingerprint(5, articles);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── Contract Validation ─────────────────────────────────────────────────────

describe('validateEventBrief', () => {
  it('accepts a fully valid brief', () => {
    const ids = new Set([1, 2]);
    const brief = makeValidBrief([1, 2]);
    expect(() => validateEventBrief(brief, ids)).not.toThrow();
  });

  it('rejects null input', () => {
    expect(() => validateEventBrief(null, new Set([1]))).toThrow('Invalid brief structure');
  });

  it('rejects non-object input', () => {
    expect(() => validateEventBrief('a string', new Set([1]))).toThrow('Invalid brief structure');
  });

  it('rejects missing summary', () => {
    const brief = makeValidBrief([1]) as Record<string, unknown>;
    delete brief.summary;
    expect(() => validateEventBrief(brief, new Set([1]))).toThrow('summary');
  });

  it('rejects summary that is too short', () => {
    const brief = makeValidBrief([1]) as Record<string, unknown>;
    brief.summary = 'Too short.';
    expect(() => validateEventBrief(brief, new Set([1]))).toThrow('summary');
  });

  it('rejects summary that is too long', () => {
    const brief = makeValidBrief([1]) as Record<string, unknown>;
    brief.summary = 'A'.repeat(2501);
    expect(() => validateEventBrief(brief, new Set([1]))).toThrow('summary');
  });

  it('rejects missing why_it_matters', () => {
    const brief = makeValidBrief([1]) as Record<string, unknown>;
    delete brief.why_it_matters;
    expect(() => validateEventBrief(brief, new Set([1]))).toThrow('why_it_matters');
  });

  it('rejects empty key_developments array', () => {
    const brief = makeValidBrief([1]) as Record<string, unknown>;
    brief.key_developments = [];
    expect(() => validateEventBrief(brief, new Set([1]))).toThrow('key_developments');
  });

  it('rejects key_developments with too many items', () => {
    const brief = makeValidBrief([1]) as Record<string, unknown>;
    brief.key_developments = Array.from({ length: 13 }, (_, i) => `Development ${i + 1} reported.`);
    expect(() => validateEventBrief(brief, new Set([1]))).toThrow('key_developments');
  });

  it('rejects key_entities with more than 20 items', () => {
    const brief = makeValidBrief([1]) as Record<string, unknown>;
    brief.key_entities = Array.from({ length: 21 }, (_, i) => ({
      name: `Entity ${i}`,
      type: 'org',
      relevance: 'Some relevance note here.',
    }));
    expect(() => validateEventBrief(brief, new Set([1]))).toThrow('key_entities');
  });

  it('rejects source_references that is empty', () => {
    const brief = makeValidBrief([]) as Record<string, unknown>;
    brief.source_references = [];
    expect(() => validateEventBrief(brief, new Set([1]))).toThrow('source_references');
  });

  it('rejects source_references with more than 30 items', () => {
    const brief = makeValidBrief([1]) as Record<string, unknown>;
    const ids = new Set(Array.from({ length: 31 }, (_, i) => i + 1));
    brief.source_references = Array.from(ids).map((id) => ({
      article_id: id,
      claim_context: 'Context note for this claim goes here.',
    }));
    expect(() => validateEventBrief(brief, ids)).toThrow('source_references');
  });

  it('rejects missing uncertainties field', () => {
    const brief = makeValidBrief([1]) as Record<string, unknown>;
    delete brief.uncertainties;
    expect(() => validateEventBrief(brief, new Set([1]))).toThrow('uncertainties');
  });
});

// ─── Grounding Validation ────────────────────────────────────────────────────

describe('validateEventBrief — grounding', () => {
  it('rejects article_id not in the event article set', () => {
    const brief = makeValidBrief([99]) as Record<string, unknown>;
    // Event only contains article 1
    expect(() => validateEventBrief(brief, new Set([1]))).toThrow(
      'Grounding violation: source reference article_id 99 is not in the event article set'
    );
  });

  it('accepts all valid article_ids in the event set', () => {
    const ids = new Set([10, 20, 30]);
    const brief = makeValidBrief([10, 20, 30]);
    expect(() => validateEventBrief(brief, ids)).not.toThrow();
  });

  it('rejects a mix of valid and invalid article_ids', () => {
    const ids = new Set([1, 2]);
    const brief = makeValidBrief([1, 99]);
    expect(() => validateEventBrief(brief, ids)).toThrow('Grounding violation');
  });

  it('deduplicates source_references with identical article_id + claim_context', () => {
    const ids = new Set([1]);
    const brief = {
      summary: 'A summary of the event that is at least twenty characters long.',
      why_it_matters: 'This matters significantly.',
      key_developments: ['Development one was noted.'],
      key_entities: [],
      uncertainties: [],
      source_references: [
        { article_id: 1, claim_context: 'Same claim text here for dedup test.' },
        { article_id: 1, claim_context: 'Same claim text here for dedup test.' },
      ],
    };
    expect(() => validateEventBrief(brief, ids)).not.toThrow();
    // After validation, duplicates should be removed
    const data = brief as Record<string, unknown>;
    const refs = data.source_references as Array<{ article_id: number; claim_context: string }>;
    expect(refs.length).toBe(1);
  });

  it('accepts string article_ids that parse to valid numbers', () => {
    const ids = new Set([5]);
    const brief = {
      summary: 'A summary of the event that is at least twenty characters long.',
      why_it_matters: 'This matters significantly.',
      key_developments: ['Development one was noted.'],
      key_entities: [],
      uncertainties: [],
      source_references: [
        { article_id: '5' as unknown as number, claim_context: 'Claim context for article five.' },
      ],
    };
    expect(() => validateEventBrief(brief, ids)).not.toThrow();
  });

  it('rejects NaN article_id', () => {
    const ids = new Set([1]);
    const brief = {
      summary: 'A summary of the event that is at least twenty characters long.',
      why_it_matters: 'This matters significantly.',
      key_developments: ['Development one was noted.'],
      key_entities: [],
      uncertainties: [],
      source_references: [
        { article_id: 'not-a-number' as unknown as number, claim_context: 'Claim.' },
      ],
    };
    expect(() => validateEventBrief(brief, ids)).toThrow('valid number');
  });
});
