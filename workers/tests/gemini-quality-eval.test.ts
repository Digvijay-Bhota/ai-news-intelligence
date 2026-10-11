/**
 * Offline tests for the Gemini quality-evaluation harness, fixtures, and
 * rubric wiring. No network access, no Gemini calls — everything here reads
 * statically-imported JSON (resolved at build time, since fs.readFileSync is
 * not implemented in the Workers test pool) and exercises pure functions.
 */
import { describe, it, expect } from 'vitest';
import {
  checkCaseDocumentation,
  validateSavedOutput,
  validateHumanScore,
  validateCaseIdForWrite,
  isSupportedModel,
  buildComparisonReport,
  renderReport,
  EVAL_MODELS,
  type EvalCase,
  type HumanScore,
  type ScoreLoadResult,
} from './gemini-quality-eval/harness';

import eventBrief01Raw from './gemini-quality-eval/cases/event-brief-01-multi-source-confirming.json';
import eventBrief02Raw from './gemini-quality-eval/cases/event-brief-02-wire-echo-same-development.json';
import eventBrief03Raw from './gemini-quality-eval/cases/event-brief-03-thin-evidence.json';
import eventBrief04Raw from './gemini-quality-eval/cases/event-brief-04-ambiguous-similar-entities.json';
import narrativeDelta01Raw from './gemini-quality-eval/cases/narrative-delta-01-material-change.json';
import narrativeDelta02Raw from './gemini-quality-eval/cases/narrative-delta-02-correction-retraction.json';
import narrativeDelta03Raw from './gemini-quality-eval/cases/narrative-delta-03-steady-no-change.json';
import narrativeDelta04Raw from './gemini-quality-eval/cases/narrative-delta-04-corroboration-evolves.json';
import claimComparison01Raw from './gemini-quality-eval/cases/claim-comparison-01-contradictory-accounts.json';
import claimComparison02Raw from './gemini-quality-eval/cases/claim-comparison-02-mixed-corroboration.json';
import claimComparison03Raw from './gemini-quality-eval/cases/claim-comparison-03-single-source-unconfirmed.json';
import claimComparison04Raw from './gemini-quality-eval/cases/claim-comparison-04-evolving-breaking-situation.json';

import eventBrief01Valid from './gemini-quality-eval/sample-outputs/event-brief-01.valid.json';
import eventBrief01Invalid from './gemini-quality-eval/sample-outputs/event-brief-01.invalid-grounding.json';
import narrativeDelta01Valid from './gemini-quality-eval/sample-outputs/narrative-delta-01.valid.json';
import narrativeDelta01Invalid from './gemini-quality-eval/sample-outputs/narrative-delta-01.invalid-grounding.json';
import claimComparison01Valid from './gemini-quality-eval/sample-outputs/claim-comparison-01.valid.json';
import claimComparison01Invalid from './gemini-quality-eval/sample-outputs/claim-comparison-01.invalid-grounding.json';

// JSON imports infer plain `string` for literal-union fields (e.g. `task`),
// so each case is cast once here to the real EvalCase shape.
const asEvalCase = (raw: unknown): EvalCase => raw as EvalCase;
const eventBrief01 = asEvalCase(eventBrief01Raw);
const eventBrief02 = asEvalCase(eventBrief02Raw);
const eventBrief03 = asEvalCase(eventBrief03Raw);
const eventBrief04 = asEvalCase(eventBrief04Raw);
const narrativeDelta01 = asEvalCase(narrativeDelta01Raw);
const narrativeDelta02 = asEvalCase(narrativeDelta02Raw);
const narrativeDelta03 = asEvalCase(narrativeDelta03Raw);
const narrativeDelta04 = asEvalCase(narrativeDelta04Raw);
const claimComparison01 = asEvalCase(claimComparison01Raw);
const claimComparison02 = asEvalCase(claimComparison02Raw);
const claimComparison03 = asEvalCase(claimComparison03Raw);
const claimComparison04 = asEvalCase(claimComparison04Raw);

const ALL_CASES: EvalCase[] = [
  eventBrief01, eventBrief02, eventBrief03, eventBrief04,
  narrativeDelta01, narrativeDelta02, narrativeDelta03, narrativeDelta04,
  claimComparison01, claimComparison02, claimComparison03, claimComparison04,
];

const REQUIRED_SCENARIO_FRAGMENTS = [
  'multiple confirming sources',
  'same development',
  'changes materially',
  'contradictory accounts',
  'correcting an earlier report',
  'two similar events could be confused',
  'thin evidence',
  'different levels of corroboration',
];

describe('gemini-quality-eval: benchmark fixtures', () => {
  it('has exactly 12 cases', () => {
    expect(ALL_CASES.length).toBe(12);
  });

  it('distributes cases evenly across the three synthesis tasks (4/4/4)', () => {
    const counts: Record<string, number> = {};
    for (const c of ALL_CASES) counts[c.task] = (counts[c.task] ?? 0) + 1;
    expect(counts).toEqual({ event_brief: 4, narrative_delta: 4, claim_comparison: 4 });
  });

  it('has unique case IDs', () => {
    const ids = ALL_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers every required scenario category at least once', () => {
    const allCategories = ALL_CASES.map((c) => c.scenario_category.toLowerCase()).join(' | ');
    for (const fragment of REQUIRED_SCENARIO_FRAGMENTS) {
      expect(allCategories).toContain(fragment);
    }
  });

  it('every case carries the documentation this benchmark requires', () => {
    for (const evalCase of ALL_CASES) {
      expect(checkCaseDocumentation(evalCase), `case ${evalCase.id}`).toEqual([]);
    }
  });

  it('every narrative_delta case supplies narrative_delta_context with distinct previous/current versions', () => {
    for (const evalCase of ALL_CASES.filter((c) => c.task === 'narrative_delta')) {
      expect(evalCase.narrative_delta_context, evalCase.id).toBeDefined();
      expect(evalCase.narrative_delta_context!.current_version).toBeGreaterThan(
        evalCase.narrative_delta_context!.previous_version
      );
    }
  });

  it('never contains anything resembling a real API key or credential', () => {
    const serialized = JSON.stringify(ALL_CASES);
    expect(serialized).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
    expect(serialized.toUpperCase()).not.toContain('GEMINI_API_KEY');
  });
});

describe('gemini-quality-eval: validateSavedOutput reuses the real production validators', () => {
  it('accepts a well-formed, correctly grounded event_brief output', () => {
    const result = validateSavedOutput(eventBrief01, eventBrief01Valid);
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('rejects an event_brief output citing an article ID outside the case evidence', () => {
    const result = validateSavedOutput(eventBrief01, eventBrief01Invalid);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Grounding violation');
    expect(result.errors[0]).toContain('99');
  });

  it('accepts a well-formed, correctly grounded narrative_delta output', () => {
    const result = validateSavedOutput(narrativeDelta01, narrativeDelta01Valid);
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('rejects a narrative_delta output citing an article ID outside the case evidence', () => {
    const result = validateSavedOutput(narrativeDelta01, narrativeDelta01Invalid);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/not in the event article set/);
  });

  it('accepts a well-formed, correctly grounded claim_comparison output', () => {
    const result = validateSavedOutput(claimComparison01, claimComparison01Valid);
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('rejects a claim_comparison output citing a source_id outside the case evidence', () => {
    const result = validateSavedOutput(claimComparison01, claimComparison01Invalid);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Referential violation');
  });

  it('never throws — a malformed/non-object output is reported as invalid, not an exception', () => {
    expect(() => validateSavedOutput(eventBrief01, null)).not.toThrow();
    expect(() => validateSavedOutput(eventBrief01, 'not an object')).not.toThrow();
    expect(validateSavedOutput(eventBrief01, null).valid).toBe(false);
  });
});

const VALID_SCORE: HumanScore = {
  reviewer: 'test-reviewer',
  factual_consistency: 5,
  information_preservation: 5,
  unsupported_claims: 5,
  uncertainty_handling: 4,
  usefulness: 4,
  invented_claims_found: [],
  missing_facts_found: [],
  justification: 'Accurate and well-grounded.',
  overall_verdict: 'pass',
};

const noScore = (): ScoreLoadResult => ({ status: 'none' });

describe('gemini-quality-eval: buildComparisonReport (fully injected I/O, no fs)', () => {
  it('honestly reports every (case, model) pair as missing when no outputs have been saved', () => {
    const results = buildComparisonReport(ALL_CASES, () => null, noScore);
    expect(results.length).toBe(ALL_CASES.length * EVAL_MODELS.length);
    expect(results.every((r) => r.status === 'missing')).toBe(true);
  });

  it('distinguishes valid/unscored, invalid, and scored outputs correctly', () => {
    const results = buildComparisonReport(
      [eventBrief01],
      (_caseId, model) => {
        if (model === 'gemini-3.5-flash-lite') return eventBrief01Valid;
        if (model === 'gemini-3.6-flash') return eventBrief01Invalid;
        return null;
      },
      noScore
    );
    const lite = results.find((r) => r.model === 'gemini-3.5-flash-lite')!;
    const pro = results.find((r) => r.model === 'gemini-3.6-flash')!;
    expect(lite.status).toBe('valid_unscored');
    expect(pro.status).toBe('invalid');
  });

  it('reports a valid output as scored once a human score is present', () => {
    const results = buildComparisonReport(
      [eventBrief01],
      () => eventBrief01Valid,
      () => ({ status: 'valid', score: VALID_SCORE })
    );
    expect(results.every((r) => r.status === 'scored')).toBe(true);
    expect(results[0].human_score).toEqual(VALID_SCORE);
    expect(results[0].score_error).toBeNull();
  });

  it('renderReport never throws and includes a count summary line', () => {
    const results = buildComparisonReport(ALL_CASES, () => null, noScore);
    const text = renderReport(ALL_CASES, results);
    expect(text).toContain('Summary:');
    expect(text).toContain(`${ALL_CASES.length * EVAL_MODELS.length} missing`);
  });
});

describe('gemini-quality-eval: validateHumanScore (Finding 1 — scorecard structure)', () => {
  it('accepts a complete, well-formed scorecard', () => {
    const result = validateHumanScore(VALID_SCORE);
    expect(result.valid).toBe(true);
    expect(result.score).toEqual(VALID_SCORE);
  });

  it('rejects a scorecard missing a required field', () => {
    const { justification, ...incomplete } = VALID_SCORE;
    const result = validateHumanScore(incomplete);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('justification');
  });

  it('rejects an out-of-range score', () => {
    const result = validateHumanScore({ ...VALID_SCORE, factual_consistency: 0 });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('factual_consistency');

    const resultTooHigh = validateHumanScore({ ...VALID_SCORE, usefulness: 6 });
    expect(resultTooHigh.valid).toBe(false);
  });

  it('rejects an invalid field type (e.g. a string where a score integer is required)', () => {
    const result = validateHumanScore({ ...VALID_SCORE, uncertainty_handling: 'high' as unknown as number });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('uncertainty_handling');
  });

  it('rejects an invalid overall_verdict value', () => {
    const result = validateHumanScore({ ...VALID_SCORE, overall_verdict: 'maybe' as unknown as HumanScore['overall_verdict'] });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('overall_verdict');
  });

  it('rejects non-string-array list fields', () => {
    const result = validateHumanScore({ ...VALID_SCORE, invented_claims_found: [1, 2] as unknown as string[] });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('invented_claims_found');
  });

  it('never throws on null, a non-object, or an array', () => {
    expect(() => validateHumanScore(null)).not.toThrow();
    expect(() => validateHumanScore('not an object')).not.toThrow();
    expect(() => validateHumanScore([VALID_SCORE])).not.toThrow();
    expect(validateHumanScore(null).valid).toBe(false);
    expect(validateHumanScore([VALID_SCORE]).valid).toBe(false);
  });
});

describe('gemini-quality-eval: corrupt/incomplete scorecards never abort the report or pass as scored (Finding 1)', () => {
  it('reports a single corrupt scorecard as corrupt_score, distinct from missing/invalid/scored', () => {
    const results = buildComparisonReport(
      [eventBrief01],
      () => eventBrief01Valid,
      () => ({ status: 'corrupt', error: 'Scorecard is not valid JSON: Unexpected token' })
    );
    expect(results[0].status).toBe('corrupt_score');
    expect(results[0].human_score).toBeNull();
    expect(results[0].score_error).toContain('not valid JSON');
  });

  it('reports an incomplete (but syntactically valid) scorecard as corrupt_score, never as scored', () => {
    const { justification, ...incomplete } = VALID_SCORE;
    const validated = validateHumanScore(incomplete);
    expect(validated.valid).toBe(false);
    const results = buildComparisonReport(
      [eventBrief01],
      () => eventBrief01Valid,
      () => ({ status: 'corrupt', error: validated.errors.join('; ') })
    );
    expect(results[0].status).toBe('corrupt_score');
    expect(results[0].human_score).toBeNull();
  });

  it('continues processing every other (case, model) pair when one scorecard is corrupt', () => {
    const results = buildComparisonReport(
      [eventBrief01, narrativeDelta01],
      (caseId) => (caseId === eventBrief01.id ? eventBrief01Valid : narrativeDelta01Valid),
      (caseId, model) => {
        if (caseId === eventBrief01.id && model === 'gemini-3.5-flash-lite') {
          return { status: 'corrupt', error: 'simulated corruption' };
        }
        return { status: 'valid', score: VALID_SCORE };
      }
    );
    expect(results.length).toBe(4);
    const corrupted = results.find((r) => r.case_id === eventBrief01.id && r.model === 'gemini-3.5-flash-lite')!;
    expect(corrupted.status).toBe('corrupt_score');
    // Every other pair, including the other model for the SAME case, is still reported normally.
    const otherModelSameCase = results.find((r) => r.case_id === eventBrief01.id && r.model === 'gemini-3.6-flash')!;
    expect(otherModelSameCase.status).toBe('scored');
    const otherCasePairs = results.filter((r) => r.case_id === narrativeDelta01.id);
    expect(otherCasePairs.every((r) => r.status === 'scored')).toBe(true);
  });

  it('renderReport includes the scorecard error text and the corrupt_score count without throwing', () => {
    const results = buildComparisonReport(
      [eventBrief01],
      () => eventBrief01Valid,
      () => ({ status: 'corrupt', error: 'missing required field: justification' })
    );
    const text = renderReport([eventBrief01], results);
    expect(text).toContain('corrupt_score');
    expect(text).toContain('missing required field: justification');
  });
});

describe('gemini-quality-eval: score write-path safety (Finding 2)', () => {
  const KNOWN_IDS = new Set(ALL_CASES.map((c) => c.id));

  it('rejects a nonexistent case ID', () => {
    const result = validateCaseIdForWrite('not-a-real-case', KNOWN_IDS);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Unknown case ID');
  });

  it('rejects a traversal-like case ID before it would ever reach a path membership check', () => {
    for (const malicious of ['../escape', '../../etc/passwd', 'foo/../../bar', 'a/b', 'a\\b']) {
      const result = validateCaseIdForWrite(malicious, KNOWN_IDS);
      expect(result.valid, malicious).toBe(false);
      expect(result.error, malicious).toContain('Invalid case ID');
    }
  });

  it('rejects an empty or whitespace-padded case ID', () => {
    expect(validateCaseIdForWrite('', KNOWN_IDS).valid).toBe(false);
    expect(validateCaseIdForWrite('  event-brief-01-multi-source-confirming  ', KNOWN_IDS).valid).toBe(false);
  });

  it('accepts every real, loaded case ID unchanged', () => {
    for (const id of KNOWN_IDS) {
      const result = validateCaseIdForWrite(id, KNOWN_IDS);
      expect(result, id).toEqual({ valid: true, error: null });
    }
  });

  it('rejects an unsupported or path-like model argument at runtime, not just via a TypeScript annotation', () => {
    expect(isSupportedModel('gemini-3.5-flash-lite')).toBe(true);
    expect(isSupportedModel('gemini-3.6-flash')).toBe(true);
    expect(isSupportedModel('gpt-4')).toBe(false);
    expect(isSupportedModel('../escape')).toBe(false);
    expect(isSupportedModel('')).toBe(false);
  });

  it('a case ID that is rejected is rejected for every model, including the two real ones', () => {
    for (const model of EVAL_MODELS) {
      expect(validateCaseIdForWrite('../escape', KNOWN_IDS).valid).toBe(false);
      expect(isSupportedModel(model)).toBe(true);
    }
  });
});
