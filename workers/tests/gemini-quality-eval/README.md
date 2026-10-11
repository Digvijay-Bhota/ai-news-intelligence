# Gemini quality-evaluation harness (Phase 1 — offline, no model calls)

This directory prepares a reproducible, **offline** framework to later
compare `gemini-3.5-flash-lite` (the default free-tier model) against
`gemini-3.6-flash` (the paid model, reached today only via the bounded
escalation path or explicit direct routing — see
`workers/src/types.ts`'s `GEMINI_MODEL_ROUTES` comment) for the three
multi-article synthesis tasks: event briefs, narrative deltas, and claim
comparisons.

**This phase does not call either model and does not claim either model is
better.** It only builds the benchmark, the rubric, and the tooling needed
to run and record that comparison once a separate, explicitly approved
experiment (Phase 5 below) actually generates outputs to review.

## What exists today

```
tests/gemini-quality-eval/
  harness.ts            Pure validation/report-building logic. Reuses the
                         real validateEventBrief / validateNarrativeDelta /
                         validateClaimComparisons from src/tasks/*— never a
                         reimplementation. No network access, no fs.
  rubric.md              The human scoring rubric (6 dimensions; see below).
  cases/                 12 synthetic benchmark fixtures (see below).
  sample-outputs/        Hand-written fixtures used only by this phase's own
                         tests, clearly labeled — NOT real model output.
  outputs/                Empty. Where real saved model outputs will go once
                         Phase 5 is approved and run.
  scores/                 Empty. Where human reviewer scorecards will go.
tests/gemini-quality-eval.test.ts   Offline tests for the harness itself.
scripts/gemini-quality-eval.ts       The CLI tool (see "Using the tool" below).
```

## The 12 benchmark cases

4 cases per task (event_brief / narrative_delta / claim_comparison), covering
every scenario the brief for this phase asked for:

| Case | Scenario |
|---|---|
| `event-brief-01-multi-source-confirming` | Straightforward story, multiple independent confirming sources |
| `event-brief-02-wire-echo-same-development` | Several articles describing the same development (incl. wire-service reprints) |
| `event-brief-03-thin-evidence` | Thin evidence that should not support a confident conclusion |
| `event-brief-04-ambiguous-similar-entities` | Two similarly-named, unrelated entities that could be confused |
| `narrative-delta-01-material-change` | A story that changes materially over time |
| `narrative-delta-02-correction-retraction` | An article correcting/retracting an earlier report |
| `narrative-delta-03-steady-no-change` | No real change — tests against inventing drama |
| `narrative-delta-04-corroboration-evolves` | Claims whose corroboration strength changes over time |
| `claim-comparison-01-contradictory-accounts` | Contradictory accounts from different sources |
| `claim-comparison-02-mixed-corroboration` | Mixed corroboration levels within one event |
| `claim-comparison-03-single-source-unconfirmed` | Thin, single-sourced, uncorroborated claim |
| `claim-comparison-04-evolving-breaking-situation` | Rapidly updating breaking situation (not disputed, just evolving) |

All article/company/person names are synthetic. No production data or
production credentials were used.

Each case fixture documents (see `harness.ts`'s `EvalCase` type):
`must_preserve_facts`, `must_not_invent`, `known_ambiguities`, and
`validation_notes` — the facts a human reviewer checks for, not anything the
schema validator itself enforces.

## The rubric

See `rubric.md`. In short: dimension 6 (structural/schema validity) is
**mechanical** — produced automatically by the harness using the real
validators. Dimensions 1–5 (factual consistency, information preservation,
unsupported/invented claims, uncertainty handling, usefulness) are **human**
judgments, 1–5, scored only after an output passes mechanical validation.
An invented claim (dimension 3 ≤ 2) fails the case regardless of the other
four scores.

## Using the tool

Everything runs via `vite-node` (already a transitive dependency of
`vitest` — no new package was added) so it can import the real TypeScript
validators directly while still having full filesystem access, which the
Workers test pool does not provide.

```bash
cd workers

# Confirm every case fixture carries the required documentation.
npx vite-node scripts/gemini-quality-eval.ts -- check-cases

# Build and print the comparison report from the verified outputs in the
# shared request ledger (honest "missing" for every unattempted pair).
npx vite-node scripts/gemini-quality-eval.ts -- report

# Record a human score for a (case, model) pair that has a verified,
# mechanically-valid saved output in the request ledger.
npx vite-node scripts/gemini-quality-eval.ts -- score <case-id> <model> \
  --reviewer "<name>" --factual <1-5> --preservation <1-5> --unsupported <1-5> \
  --uncertainty <1-5> --usefulness <1-5> --verdict <pass|fail|needs_review> \
  --justification "<text>"
```

The tool never calls Gemini, never reads `Env`/credentials, and never
touches the automatic escalation path or any production system.

## Offline tests

```bash
npx vitest run tests/gemini-quality-eval.test.ts
```

Covers: fixture count/distribution/uniqueness/scenario coverage, every
case's required documentation fields, that the harness correctly accepts
well-formed output and correctly rejects ungrounded output via the real
validators, and that `buildComparisonReport` honestly reports "missing"
rather than fabricating a result.

---

## Comparison runner (implemented; not yet executed)

`scripts/gemini-quality-comparison-runner.ts` implements the controlled
comparison proposed below. It calls the real production generators once per
(case, model) pair, for at most 24 requests in total. Its executable entry
point is the wrapper `scripts/run-gemini-quality-comparison.ts`; importing the
implementation module never runs anything.

```bash
# Dry-run (default): read-only, no network, no API key, writes nothing.
npx vite-node scripts/run-gemini-quality-comparison.ts
# Offline recovery / local copies: no key, no requests (see below).
npx vite-node scripts/run-gemini-quality-comparison.ts -- --reconcile
# Live run — requires separate approval and GEMINI_QUALITY_EVAL_API_KEY
# (GEMINI_API_KEY is never used as a fallback). Note the `--`.
npx vite-node scripts/run-gemini-quality-comparison.ts -- --execute
```

- **Request ledger:** `~/.local/state/ai-news-intelligence/gemini-quality-eval/`
  (resolved from the OS user database, not `$HOME`; no flag or environment
  variable relocates it). Shared by every worktree, clone and `--eval-root` on
  this machine, and keyed only by (case, model) — there is no experiment ID,
  so no checkout can request a pair that was ever reserved. Layout:
  `LEDGER_FORMAT`, `request-budget/` (24 slot files), `reservations/`,
  `run-logs/`, `outputs/`. A ledger in any other layout (including the
  per-experiment layout of the first runner version) is refused, never
  migrated or deleted.
- **Write order per pair:** reservation (before the request, never refunded)
  → request (at most one) → canonical output in the ledger's `outputs/` →
  run-log recording the output's SHA-256 (the commit point) → a convenience
  copy in this checkout's `outputs/`. Every ledger file is published
  atomically, write-once, and fsync'd.
- **States:** `not_attempted`, `ambiguous` (reserved, no outcome — never
  re-sent), `incomplete` (output saved, completion not recorded),
  `completed`, `failed` (never retried), and `corrupt` (impossible
  combination or SHA-256 mismatch — reported precisely; `--execute` and
  `--reconcile` refuse to proceed, nothing is reset or repeated).
- **`--reconcile`** (also run automatically at the start of `--execute`)
  completes `incomplete` pairs whose saved output re-validates, and copies
  every verified completed output into this checkout's `outputs/`. It never
  overwrites a local file; a differing one is reported and left alone.
- **Report and scoring** (`scripts/gemini-quality-eval.ts`) read only
  verified canonical outputs from the ledger, so any checkout — even one
  with an empty `outputs/` — reports the same results, and a local file is
  never reported or scored as valid. `--outputs-dir` was removed for this
  reason.
- **Limitation:** this is a local file ledger. It cannot coordinate usage
  across different physical machines or OS user accounts; each of those
  would have its own 24-request budget.
- Tests (mocked network, temporary ledgers; the real one is refused under
  Vitest): `npm run test:ledger` and
  `npx vitest run tests/gemini-quality-eval-runner.test.ts`.

---

## Phase 5 — proposal for a future, separately approved comparison

This is a proposal only. **Nothing below is executed by this phase.**

### Scope
- All 12 cases above, run once against each model for each case's task —
  **24 total Gemini API requests maximum** (12 cases × 2 models). No
  retries beyond what the existing model-router already does for a genuine
  transient failure; a request that fails for a reason unrelated to the
  experiment (e.g. a transient 5xx) may be attempted again, but the
  experiment must stop and report rather than silently retrying past this
  cap.
- Model per task: for every case, the "Lite" output is generated with
  `gemini-3.5-flash-lite` (the task's existing free-tier default) and the
  comparison output is generated with `gemini-3.6-flash`, using the exact
  same prompt templates and grounded-evidence formatting already used in
  production (`generateEventBriefFromGemini`, `generateNarrativeDeltaFromGemini`,
  `generateClaimComparisonsFromGemini`) — no prompt changes.

### Independent hard request cap — why a separate one is required
The production automatic-escalation budget
(`GEMINI_ESCALATION_DAILY_LIMIT`, hard-capped at `ESCALATION_HARD_MAX_PER_DAY`
= 2/day) **does not apply** to a direct, explicitly configured
`GEMINI_MODEL_ROUTES` call to `gemini-3.6-flash` — that is deliberate,
documented, operator-selected routing with no daily cap of its own (see
`workers/src/types.ts`). This experiment calls `gemini-3.6-flash` directly
for benchmarking, so it **must not rely on the production escalation budget
as a safety net** — it has none here. Instead, the experiment's own runner
must enforce its own hard ceiling (24 requests, see above) independently of
and in addition to anything in `gemini-escalation.ts`, and must stop and
report immediately on reaching it rather than continuing.

### How outputs will be stored and reviewed
- Raw parsed JSON outputs saved to `tests/gemini-quality-eval/outputs/` as
  `<case-id>.<model>.json`, exactly as the real harness already expects.
- Human review recorded via the existing `score` CLI command into
  `tests/gemini-quality-eval/scores/`, following `rubric.md`.
- At least one reviewer per `(case, model)` pair; cases where the rubric's
  dimension 3 (unsupported claims) is ambiguous should get a second,
  independent reviewer before a final verdict is recorded.

### How quotas, cost, and usage will be bounded
- The 24-request hard cap above is enforced by the experiment's own runner
  script (separate from and in addition to production's escalation budget),
  which must refuse to issue request 25.
- The runner must use a dedicated, clearly-labeled API key/project (never
  the production `GEMINI_API_KEY`) so usage is separately attributable and
  cannot silently draw down the production project's quota.
- The runner must log each request's case ID, model, and timestamp (never
  the API key, never raw request/response bodies beyond what's saved to
  `outputs/`) so the 24-request ceiling is independently auditable after
  the fact.

### How the experiment will remain isolated from production
- It must run from an isolated worktree/branch, never from a branch that
  gets merged to `main` without separate review of its results.
- It must not touch production D1, KV, Cloudflare configuration, or
  secrets, and must not enable `GEMINI_ESCALATION_ENABLED` in any production
  environment as a side effect of this work.
- It must not request or process any of the 229 previously exhausted
  production articles — only the 12 synthetic cases defined in `cases/`.
- Migration `0013_gemini_escalation_budget.sql` must remain unapplied to
  production throughout; this experiment does not use the escalation budget
  table at all (it calls `gemini-3.6-flash` directly, not through the
  escalation path).

### How results will be evaluated without assuming Gemini 3.6 is better
- The comparison report and rubric treat the two models symmetrically: the
  same 12 cases, the same rubric, the same reviewer pool, applied blind to
  which model produced which saved output where practical (e.g. by
  shuffling filenames presented to a reviewer, if the review tooling is
  later extended to support that).
- Findings must be reported per-dimension, not as a single aggregate "3.6
  wins" headline — e.g. 3.6 may show no measurable improvement on factual
  consistency while incurring real cost, which is itself a valid and
  reportable finding.
- A sample of 12 synthetic cases is a start, not a statistically
  representative claim about production traffic; any write-up of results
  must say so explicitly, consistent with this phase's own rubric.md.

This proposal requires separate, explicit approval (including provisioning
a dedicated API key/project and confirming the 24-request cap) before any
request is made.
