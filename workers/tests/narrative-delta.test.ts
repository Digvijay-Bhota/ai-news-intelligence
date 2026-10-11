/**
 * narrative-delta.test.ts — Phase 10: Narrative Evolution Tests
 *
 * Tests schema validation, provenance enforcement, and grounding rules
 * for the Narrative Evolution Delta Engine.
 */

import { describe, it, expect } from 'vitest';
import { validateNarrativeDelta } from '../src/tasks/narrative-delta-generator';
import narrativeDelta02 from './gemini-quality-eval/cases/narrative-delta-02-correction-retraction.json';

const makeValidDelta = (articleIds: number[]) => ({
  previous_version: 1,
  current_version: 2,
  summary: 'Reporting has evolved with newly verified regulatory filings and confirmed executive departure.',
  newly_confirmed: [
    {
      statement: 'The CEO confirmed resignation in a public statement.',
      source_references: [articleIds[0]],
    },
  ],
  changed_claims: [
    {
      previous_statement: 'The acquisition price was estimated at $1B.',
      current_statement: 'Official filings indicate the deal is valued at $1.4B.',
      change_type: 'refined',
      source_references: [articleIds[0]],
    },
  ],
  removed_or_no_longer_supported: [
    {
      statement: 'Prior rumors of a hostile takeover bid have been dismissed.',
      source_references: [articleIds[0]],
    },
  ],
  unchanged_core: [
    'The company remains under active antitrust scrutiny.',
  ],
  open_questions: [
    'Whether the board will appoint an interim or permanent successor.',
  ],
});

describe('validateNarrativeDelta', () => {
  it('accepts a fully valid narrative delta', () => {
    const validIds = new Set([10, 20]);
    const raw = makeValidDelta([10]);
    expect(() => validateNarrativeDelta(raw, validIds, 1, 2)).not.toThrow();
    expect(raw.previous_version).toBe(1);
    expect(raw.current_version).toBe(2);
  });

  it('rejects null or non-object input', () => {
    const validIds = new Set([1]);
    expect(() => validateNarrativeDelta(null, validIds, 1, 2)).toThrow('expected a JSON object');
    expect(() => validateNarrativeDelta('invalid', validIds, 1, 2)).toThrow('expected a JSON object');
  });

  it('rejects summary that is too short', () => {
    const validIds = new Set([1]);
    const raw = { ...makeValidDelta([1]), summary: 'Too short.' };
    expect(() => validateNarrativeDelta(raw, validIds, 1, 2)).toThrow('summary must be a string between 15 and 2000 characters');
  });

  it('enforces provenance: rejects article_id in newly_confirmed not in validArticleIds', () => {
    const validIds = new Set([1, 2]);
    const raw = makeValidDelta([1]);
    raw.newly_confirmed[0].source_references = [999];
    expect(() => validateNarrativeDelta(raw, validIds, 1, 2)).toThrow(
      'Grounding violation in narrative delta: source reference article_id 999 in newly_confirmed[0] is not in the event article set'
    );
  });

  it('enforces provenance: rejects article_id in changed_claims not in validArticleIds', () => {
    const validIds = new Set([1, 2]);
    const raw = makeValidDelta([1]);
    raw.changed_claims[0].source_references = [999];
    expect(() => validateNarrativeDelta(raw, validIds, 1, 2)).toThrow(
      'Grounding violation in narrative delta: source reference article_id 999 in changed_claims[0] is not in the event article set'
    );
  });

  it('enforces provenance: rejects article_id in removed_or_no_longer_supported not in validArticleIds', () => {
    const validIds = new Set([1, 2]);
    const raw = makeValidDelta([1]);
    raw.removed_or_no_longer_supported[0].source_references = [999];
    expect(() => validateNarrativeDelta(raw, validIds, 1, 2)).toThrow(
      'Grounding violation in narrative delta: source reference article_id 999 in removed_or_no_longer_supported[0] is not in the event article set'
    );
  });

  it('rejects invalid or missing change_type values', () => {
    const validIds = new Set([1]);
    const invalidTypes = ['definitely_true', 'contradict', '', null, undefined, 'unknown_type'];
    for (const badType of invalidTypes) {
      const raw = makeValidDelta([1]);
      raw.changed_claims[0].change_type = badType as any;
      expect(() => validateNarrativeDelta(raw, validIds, 1, 2)).toThrow(/Invalid changed_claims change_type/);
    }
  });

  it('accepts valid change types: refined, expanded, contradicted, retracted, uncertain', () => {
    const validIds = new Set([1]);
    for (const ct of ['refined', 'expanded', 'contradicted', 'retracted', 'uncertain'] as const) {
      const raw = makeValidDelta([1]);
      raw.changed_claims[0].change_type = ct;
      expect(() => validateNarrativeDelta(raw, validIds, 1, 2)).not.toThrow();
      expect(raw.changed_claims[0].change_type).toBe(ct);
    }
  });

  it('deduplicates source references in newly_confirmed', () => {
    const validIds = new Set([1]);
    const raw = makeValidDelta([1]);
    raw.newly_confirmed[0].source_references = [1, 1, 1];
    expect(() => validateNarrativeDelta(raw, validIds, 1, 2)).not.toThrow();
    expect(raw.newly_confirmed[0].source_references).toEqual([1]);
  });

  it('gracefully handles missing optional arrays by initializing empty arrays', () => {
    const validIds = new Set([1]);
    const raw: any = {
      summary: 'Reporting has evolved with newly verified regulatory filings and confirmed departure.',
    };
    expect(() => validateNarrativeDelta(raw, validIds, 1, 2)).not.toThrow();
    expect(raw.newly_confirmed).toEqual([]);
    expect(raw.changed_claims).toEqual([]);
    expect(raw.removed_or_no_longer_supported).toEqual([]);
    expect(raw.unchanged_core).toEqual([]);
    expect(raw.open_questions).toEqual([]);
  });
});

// ─── change_type vocabulary regression (offline Gemini evaluation, narrative-delta-02) ───
describe('validateNarrativeDelta: official correction and the change_type contract', () => {
  const validIds = new Set(narrativeDelta02.articles.map((a) => a.id));
  const { previous_version, current_version } = narrativeDelta02.narrative_delta_context;

  /** The exact output recorded from Gemini 3.5 Flash-Lite, with an overridable change_type. */
  const recordedDelta = (changeType: string) => ({
    summary:
      'The fire department has issued a corrected casualty count for the Carrow Street manufacturing facility explosion, revising the initial report of three injured individuals with one critical to two injured individuals, both of whom are in stable condition.',
    newly_confirmed: [{ statement: 'The total number of injured individuals is two, and both are in stable condition.', source_references: [51] }],
    changed_claims: [
      {
        previous_statement: 'Three people were injured, with one in critical condition.',
        current_statement: 'Two people were injured, and both are stable; the earlier critical injury report was attributed to mistaken identity.',
        change_type: changeType,
        source_references: [51],
      },
    ],
    removed_or_no_longer_supported: [] as unknown[],
    unchanged_core: ['An explosion occurred at the manufacturing facility on Carrow Street.'],
    open_questions: ['What caused the explosion at the Carrow Street manufacturing facility?'],
  });

  it('rejects the recorded "corrected" change_type with the exact contract error', () => {
    expect(() => validateNarrativeDelta(recordedDelta('corrected'), validIds, previous_version, current_version)).toThrow(
      'Invalid changed_claims change_type at index 0: "corrected". Allowed values are: refined, expanded, contradicted, retracted, uncertain'
    );
  });

  it('accepts the official casualty-count correction when the earlier figure is marked "retracted"', () => {
    const delta = recordedDelta('retracted');
    expect(() => validateNarrativeDelta(delta, validIds, previous_version, current_version)).not.toThrow();
    expect(delta.changed_claims[0].change_type).toBe('retracted');
  });

  it('preserves the enum contract exactly: the five values are accepted, synonyms are not', () => {
    const candidates = ['refined', 'expanded', 'contradicted', 'retracted', 'uncertain', 'corrected', 'correction', 'retraction', 'updated', 'revised', 'withdrawn'];
    const accepted = candidates.filter((ct) => {
      try {
        validateNarrativeDelta(recordedDelta(ct), validIds, previous_version, current_version);
        return true;
      } catch {
        return false;
      }
    });
    expect(accepted).toEqual(['refined', 'expanded', 'contradicted', 'retracted', 'uncertain']);
  });
});
