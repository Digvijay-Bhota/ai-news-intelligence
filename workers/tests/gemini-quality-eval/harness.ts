/**
 * Offline Gemini quality-evaluation harness — core logic.
 *
 * Pure functions only: no network access, no Gemini calls, no filesystem
 * access, no Env/credentials. Disk I/O (reading case fixtures, saved model
 * outputs, writing human scorecards) is deliberately kept OUT of this file
 * and injected by callers instead, so that:
 *   - scripts/gemini-quality-eval.ts (a plain Node CLI run via `vite-node`)
 *     can wire real fs access for ad-hoc use against arbitrary saved files.
 *   - tests/gemini-quality-eval.test.ts can exercise the same logic inside
 *     the Workers test pool, which does not implement fs.readFileSync, by
 *     injecting in-memory data instead.
 *
 * Mechanical schema/grounding validation is never reimplemented here: it
 * reuses the exact validators the production generators call
 * (validateEventBrief, validateNarrativeDelta, validateClaimComparisons),
 * so this harness can never silently drift from the real acceptance gate.
 */

import { validateEventBrief } from '../../src/tasks/brief-generator';
import { validateNarrativeDelta } from '../../src/tasks/narrative-delta-generator';
import { validateClaimComparisons } from '../../src/tasks/claim-comparison-generator';
import { GeminiOutputValidationError } from '../../src/tasks/gemini-errors';

export type EvalTask = 'event_brief' | 'narrative_delta' | 'claim_comparison';

/** One synthetic, documented benchmark scenario. Matches the real generators' input shapes exactly. */
export interface EvalCaseArticle {
  id: number;
  source_id: number;
  source: string;
  title: string;
  summary: string | null;
  raw_content: string | null;
  published_at: number | null;
}

export interface NarrativeDeltaContext {
  /** A hand-authored prior EventBrief (Version N-1), matching the real EventBrief shape. */
  previous_brief: {
    summary: string;
    why_it_matters: string;
    key_developments: string[];
    key_entities: { name: string; type: string; relevance: string }[];
    uncertainties: string[];
    source_references: { article_id: number; claim_context: string }[];
  };
  previous_version: number;
  current_version: number;
}

export interface EvalCase {
  id: string;
  task: EvalTask;
  /** One of the eight documented scenario categories (see README.md). */
  scenario_category: string;
  description: string;
  event: { title: string; description: string | null; severity: string };
  articles: EvalCaseArticle[];
  narrative_delta_context?: NarrativeDeltaContext;
  /** Facts a good output must preserve/represent. Used only for human scoring — never auto-checked. */
  must_preserve_facts: string[];
  /** Claims that are NOT supported by the evidence and must never appear in output. */
  must_not_invent: string[];
  /** Known traps: ambiguity, conflicting reports, thin evidence, etc. */
  known_ambiguities: string[];
  /** Notes on which mechanical validation rules are especially exercised by this case. */
  validation_notes: string;
}

export interface ValidationResult {
  valid: boolean;
  /** Empty when valid. Exactly one entry (the validator throws on the first violation) when invalid. */
  errors: string[];
}

function validArticleIdSet(cases: EvalCase): Set<number> {
  return new Set(cases.articles.map((a) => a.id));
}

function validSourceIdSet(cases: EvalCase): Set<number> {
  return new Set(cases.articles.map((a) => a.source_id));
}

/**
 * Mechanically validates a saved model output against the real schema/grounding
 * rules for the case's task. Never throws; a validation failure is reported in
 * the result, not as an exception. This is pass/fail structural validation —
 * it says nothing about editorial quality (see rubric.md for that).
 */
export function validateSavedOutput(evalCase: EvalCase, rawOutput: unknown): ValidationResult {
  try {
    switch (evalCase.task) {
      case 'event_brief':
        validateEventBrief(rawOutput, validArticleIdSet(evalCase));
        return { valid: true, errors: [] };
      case 'narrative_delta': {
        const ctx = evalCase.narrative_delta_context;
        if (!ctx) throw new Error('Case is missing narrative_delta_context');
        validateNarrativeDelta(rawOutput, validArticleIdSet(evalCase), ctx.previous_version, ctx.current_version);
        return { valid: true, errors: [] };
      }
      case 'claim_comparison':
        validateClaimComparisons(rawOutput, validArticleIdSet(evalCase), validSourceIdSet(evalCase));
        return { valid: true, errors: [] };
    }
  } catch (e) {
    if (e instanceof GeminiOutputValidationError || e instanceof Error) {
      return { valid: false, errors: [e.message] };
    }
    return { valid: false, errors: ['Unknown validation error'] };
  }
}

/** Checks a case fixture carries the documentation this benchmark requires (not a quality judgment). */
export function checkCaseDocumentation(evalCase: EvalCase): string[] {
  const problems: string[] = [];
  if (evalCase.must_preserve_facts.length === 0) problems.push('must_preserve_facts is empty');
  if (evalCase.must_not_invent.length === 0) problems.push('must_not_invent is empty');
  if (evalCase.known_ambiguities.length === 0) problems.push('known_ambiguities is empty');
  if (!evalCase.validation_notes.trim()) problems.push('validation_notes is empty');
  if (evalCase.articles.length === 0) problems.push('articles is empty');
  if (evalCase.task === 'narrative_delta' && !evalCase.narrative_delta_context) {
    problems.push('narrative_delta case is missing narrative_delta_context');
  }
  return problems;
}

export const EVAL_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.6-flash'] as const;
export type EvalModel = (typeof EVAL_MODELS)[number];

export type OutputStatus = 'missing' | 'invalid' | 'valid_unscored' | 'scored' | 'corrupt_score';

export interface HumanScore {
  reviewer: string;
  /** 1 (worst) to 5 (best); see rubric.md for anchors. */
  factual_consistency: number;
  information_preservation: number;
  /** Treated as a near pass/fail gate, not just one input among many: a score <= 2 fails the case. */
  unsupported_claims: number;
  uncertainty_handling: number;
  usefulness: number;
  invented_claims_found: string[];
  missing_facts_found: string[];
  justification: string;
  overall_verdict: 'pass' | 'fail' | 'needs_review';
}

const SCORE_RANGE_FIELDS = [
  'factual_consistency',
  'information_preservation',
  'unsupported_claims',
  'uncertainty_handling',
  'usefulness',
] as const;

const VALID_VERDICTS = ['pass', 'fail', 'needs_review'] as const;

export type HumanScoreValidationResult =
  | { valid: true; score: HumanScore; errors: [] }
  | { valid: false; score: null; errors: string[] };

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Validates a parsed scorecard against the complete HumanScore structure:
 * every required field present, score fields integers in [1, 5], verdict
 * one of the three allowed values, list fields arrays of strings. Never
 * throws. Used both to accept a scorecard on read and (by the CLI) to
 * reject an incomplete one before it is ever written.
 */
export function validateHumanScore(raw: unknown): HumanScoreValidationResult {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, score: null, errors: ['Scorecard must be a JSON object'] };
  }
  const r = raw as Record<string, unknown>;

  if (typeof r.reviewer !== 'string' || !r.reviewer.trim()) {
    errors.push('reviewer must be a non-empty string');
  }
  for (const field of SCORE_RANGE_FIELDS) {
    const v = r[field];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 5) {
      errors.push(`${field} must be an integer between 1 and 5`);
    }
  }
  if (!isStringArray(r.invented_claims_found)) {
    errors.push('invented_claims_found must be an array of strings');
  }
  if (!isStringArray(r.missing_facts_found)) {
    errors.push('missing_facts_found must be an array of strings');
  }
  if (typeof r.justification !== 'string' || !r.justification.trim()) {
    errors.push('justification must be a non-empty string');
  }
  if (typeof r.overall_verdict !== 'string' || !(VALID_VERDICTS as readonly string[]).includes(r.overall_verdict)) {
    errors.push(`overall_verdict must be one of: ${VALID_VERDICTS.join(', ')}`);
  }

  if (errors.length > 0) return { valid: false, score: null, errors };
  return { valid: true, score: r as unknown as HumanScore, errors: [] };
}

export interface CaseModelResult {
  case_id: string;
  model: EvalModel;
  status: OutputStatus;
  validation: ValidationResult | null;
  human_score: HumanScore | null;
  /** Set only when status is 'corrupt_score': why the saved scorecard was rejected. */
  score_error: string | null;
}

/**
 * What a scorecard reader found for one (case, model) pair. A distinct type
 * from a plain `HumanScore | null` so a corrupt/incomplete scorecard can
 * never be confused with "no scorecard exists yet" or silently treated as
 * fully scored.
 */
export type ScoreLoadResult =
  | { status: 'none' }
  | { status: 'valid'; score: HumanScore }
  | { status: 'corrupt'; error: string };

/**
 * Builds the comparison report for every (case, model) pair. Disk/output
 * access is fully injected via `readOutput`/`readScore` so this stays a pure
 * function usable both from the real CLI (backed by fs) and from tests
 * (backed by in-memory fixtures, since fs.readFileSync does not work inside
 * the Workers test pool). Neither callback is expected to throw; a corrupt
 * scorecard must be reported as 'corrupt', not raised as an exception, so
 * that one bad file never aborts the rest of the report.
 */
export function buildComparisonReport(
  cases: EvalCase[],
  readOutput: (caseId: string, model: EvalModel) => unknown | null,
  readScore: (caseId: string, model: EvalModel) => ScoreLoadResult
): CaseModelResult[] {
  const results: CaseModelResult[] = [];
  for (const evalCase of cases) {
    for (const model of EVAL_MODELS) {
      const rawOutput = readOutput(evalCase.id, model);
      if (rawOutput === null || rawOutput === undefined) {
        results.push({ case_id: evalCase.id, model, status: 'missing', validation: null, human_score: null, score_error: null });
        continue;
      }
      const validation = validateSavedOutput(evalCase, rawOutput);
      const scoreResult = readScore(evalCase.id, model);

      if (!validation.valid) {
        results.push({ case_id: evalCase.id, model, status: 'invalid', validation, human_score: null, score_error: null });
        continue;
      }
      if (scoreResult.status === 'corrupt') {
        results.push({ case_id: evalCase.id, model, status: 'corrupt_score', validation, human_score: null, score_error: scoreResult.error });
        continue;
      }
      if (scoreResult.status === 'valid') {
        results.push({ case_id: evalCase.id, model, status: 'scored', validation, human_score: scoreResult.score, score_error: null });
        continue;
      }
      results.push({ case_id: evalCase.id, model, status: 'valid_unscored', validation, human_score: null, score_error: null });
    }
  }
  return results;
}

/** Renders a comparison report as plain text, suitable for terminal output or a saved report file. */
export function renderReport(cases: EvalCase[], results: CaseModelResult[]): string {
  const byCase = new Map(cases.map((c) => [c.id, c]));
  const lines: string[] = [];
  lines.push('Gemini quality-evaluation report');
  lines.push('================================');
  lines.push('');
  lines.push('This report records mechanical validation and (if present) recorded human');
  lines.push('scores only. It is not evidence of model quality by itself — see rubric.md.');
  lines.push('');

  const grouped = new Map<string, CaseModelResult[]>();
  for (const r of results) {
    const list = grouped.get(r.case_id) ?? [];
    list.push(r);
    grouped.set(r.case_id, list);
  }

  for (const [caseId, caseResults] of grouped) {
    const evalCase = byCase.get(caseId);
    lines.push(`Case: ${caseId}${evalCase ? ` [${evalCase.task}] — ${evalCase.scenario_category}` : ''}`);
    for (const r of caseResults) {
      lines.push(`  ${r.model}: ${r.status}`);
      if (r.validation && !r.validation.valid) lines.push(`    validation error: ${r.validation.errors[0]}`);
      if (r.status === 'corrupt_score' && r.score_error) lines.push(`    scorecard error: ${r.score_error}`);
      if (r.human_score) {
        lines.push(`    overall: ${r.human_score.overall_verdict} (reviewer: ${r.human_score.reviewer})`);
        lines.push(
          `    scores: factual=${r.human_score.factual_consistency} preservation=${r.human_score.information_preservation} ` +
            `unsupported_claims=${r.human_score.unsupported_claims} uncertainty=${r.human_score.uncertainty_handling} usefulness=${r.human_score.usefulness}`
        );
      }
    }
    lines.push('');
  }

  const missing = results.filter((r) => r.status === 'missing').length;
  const invalid = results.filter((r) => r.status === 'invalid').length;
  const scored = results.filter((r) => r.status === 'scored').length;
  const unscored = results.filter((r) => r.status === 'valid_unscored').length;
  const corruptScore = results.filter((r) => r.status === 'corrupt_score').length;
  lines.push(
    `Summary: ${results.length} (case, model) pairs — ${missing} missing, ${invalid} invalid, ${unscored} valid/unscored, ` +
      `${scored} scored, ${corruptScore} corrupt_score.`
  );
  return lines.join('\n');
}

// ─── Score-write-path safety (used by the `score` CLI command) ────────────
//
// Pure, fs-free validation: the CLI is responsible for loading the real case
// IDs and must reject an unsafe or unknown caseId/model BEFORE building any
// file path, never after. Kept here (not in scripts/gemini-quality-eval.ts)
// so it can be unit-tested directly without fs — the same reason
// validateSavedOutput/validateHumanScore live here.

export interface CaseIdCheck {
  valid: boolean;
  /** Present only when valid is false. */
  error: string | null;
}

/**
 * Validates an operator-supplied case ID before it is ever interpolated into
 * a file path. Rejects path separators, ".." traversal segments, leading/
 * trailing whitespace, and anything that isn't one of the real, loaded case
 * IDs — never relies on the caller to have sanitized the value first.
 */
export function validateCaseIdForWrite(caseId: string, knownCaseIds: ReadonlySet<string>): CaseIdCheck {
  if (!caseId || caseId !== caseId.trim()) {
    return { valid: false, error: `Invalid case ID: ${JSON.stringify(caseId)}` };
  }
  if (/[\\/]/.test(caseId) || caseId.includes('..')) {
    return { valid: false, error: `Invalid case ID: ${caseId}` };
  }
  if (!knownCaseIds.has(caseId)) {
    return { valid: false, error: `Unknown case ID: ${caseId}. Run 'check-cases' to list valid case IDs.` };
  }
  return { valid: true, error: null };
}

/**
 * Validates a model identifier against the explicit allowlist at runtime —
 * a TypeScript type annotation alone does not stop an arbitrary string
 * (e.g. a path-like value) from reaching this far at runtime, so this check
 * must happen before the value is ever used to build a file path.
 */
export function isSupportedModel(model: string): model is EvalModel {
  return (EVAL_MODELS as readonly string[]).includes(model);
}
