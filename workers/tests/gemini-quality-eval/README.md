# Gemini quality-evaluation harness and comparison runner

This directory holds a reproducible framework for comparing
`gemini-3.5-flash-lite` (the default free-tier model) against
`gemini-3.6-flash` (the paid model, reached today only via the bounded
escalation path or explicit direct routing — see
`workers/src/types.ts`'s `GEMINI_MODEL_ROUTES` comment) for the three
multi-article synthesis tasks: event briefs, narrative deltas, and claim
comparisons.

It has two parts:

- **Phase 1 — offline harness:** the 12 benchmark cases, the human scoring
  rubric, and the report/score tool. None of these ever calls a model.
- **Phase 2 — comparison runner** (see "Comparison runner" below): can make
  at most 24 real Gemini requests (12 cases × 2 models). It is implemented
  and tested with mocked network calls only. **It has not been executed.**
  A live run (`--execute`) requires separate, explicit approval and a
  dedicated API key.

Nothing here claims either model is better.

## What exists today

```
tests/gemini-quality-eval/
  harness.ts            Pure validation/report-building logic. Reuses the
                         real validateEventBrief / validateNarrativeDelta /
                         validateClaimComparisons from src/tasks/*— never a
                         reimplementation. No network access, no fs.
  runner.ts              Pure runner logic: plan, run-log records, pair-state
                         classification, redaction. No fs, no network.
  ledger.ts              Request-ledger primitives: 24-slot budget,
                         reservations, write-once fsync'd files.
  ledger-state.ts        Verified reads, report/score sources, offline
                         reconciliation.
  test-support.ts        Shared fixtures for the runner/ledger tests.
  rubric.md              The human scoring rubric (6 dimensions; see below).
  cases/                 12 synthetic benchmark fixtures (see below).
  sample-outputs/        Hand-written fixtures used only by the harness's own
                         tests, clearly labeled — NOT real model output.
  outputs/               Local convenience copies of verified, valid outputs,
                         written by the runner. Never authoritative: report
                         and score read the request ledger. Empty until run.
  scores/                Human reviewer scorecards (per checkout). Empty.
tests/gemini-quality-eval.test.ts        Offline tests for the harness.
tests/gemini-quality-eval-*.test.ts,
tests/gemini-quality-comparison-runner*.test.ts
                                         Runner/ledger tests (npm run test:ledger).
scripts/gemini-quality-eval.ts           Report/score tool ("Using the tool").
scripts/run-gemini-quality-comparison.ts Runner entry point ("Comparison runner").
scripts/gemini-quality-comparison-runner.ts
                                         Runner implementation; importing it
                                         never runs anything.
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
# Dry-run (default): read-only, no network, writes nothing, never uses a key.
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
  `run-logs/`, `outputs/` (valid outputs), `rejected-outputs/` (model text
  that failed validation). A ledger in any other layout (including the
  per-experiment layout of the first runner version) is refused, never
  migrated or deleted.
- **Write order per pair:** reservation (before the request, never refunded)
  → request (at most one; no retries of any kind) → the model's output →
  run-log recording that output's SHA-256 (the commit point). A valid output
  goes to the ledger's `outputs/` and then a convenience copy to this
  checkout's `outputs/`. Output that fails mechanical validation (schema,
  grounding, or unparseable JSON) is preserved as the model's exact raw text
  in `rejected-outputs/` and recorded as `invalid` with its validation
  errors — never discarded, never treated as valid, never retried. Every
  ledger file is published atomically, write-once, and fsync'd. Output that
  would contain the API key is never stored.
- **States:** `not_attempted`, `ambiguous` (reserved, no outcome — never
  re-sent), `incomplete` (output saved, completion not recorded),
  `completed`, `invalid` (output failed validation; preserved for review),
  `failed` (no model output, e.g. HTTP/network error; never retried), and
  `corrupt` (impossible combination or SHA-256 mismatch — reported
  precisely; `--execute` and `--reconcile` refuse to proceed, nothing is
  reset or repeated).
- **`--reconcile`** (also run automatically at the start of `--execute`)
  completes `incomplete` pairs offline — a saved valid output only if it
  re-validates, a saved rejected output only if it still fails validation —
  and copies every verified valid output into this checkout's `outputs/`.
  It never overwrites a local file; a differing one is reported and left
  alone.
- **Report and scoring** (`scripts/gemini-quality-eval.ts`) read only
  hash-verified outputs from the ledger, so any checkout — even one with an
  empty `outputs/` — reports the same results, and a local file is never
  reported or scored as valid. Preserved invalid outputs are reported as
  `invalid` with their validation errors and ledger path; they cannot be
  scored. `--outputs-dir` was removed for this reason.
- **Limitation:** this is a local file ledger. It cannot coordinate usage
  across different physical machines or OS user accounts; each of those
  would have its own 24-request budget.
- Tests (mocked network, temporary ledgers; the real one is refused under
  Vitest): `npm run test:ledger` and
  `npx vitest run tests/gemini-quality-eval-runner.test.ts`. Workers CI runs
  both, and then fails if the real user-level ledger exists.

---

## Experiment design (implemented by the comparison runner)

This section records the design the comparison runner implements. **The
experiment has not been run;** executing it still requires separate,
explicit approval.

### Scope
- All 12 cases above, run once against each model for each case's task —
  **24 total Gemini API requests maximum** (12 cases × 2 models).
- **No retries of any kind.** Each pair is requested at most once; a
  failed, invalid or interrupted request keeps its reservation and is never
  re-sent, even after a transient error such as a 5xx. The runner calls the
  generators directly, not through the model router, so the router's
  retries and model fallbacks do not apply.
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
for benchmarking, so it **does not rely on the production escalation budget
as a safety net** — it has none here. Instead, the runner enforces its own
hard ceiling (24 requests, see above) through the shared request ledger,
independently of and in addition to anything in `gemini-escalation.ts`, and
stops and reports as soon as it is reached.

### How outputs are stored and reviewed
- Valid outputs: the authoritative, SHA-256-verified copy is in the request
  ledger's `outputs/<case-id>.<model>.json`; a convenience copy is written to
  `tests/gemini-quality-eval/outputs/` in the checkout that runs or
  reconciles.
- Outputs that fail mechanical validation: the model's exact raw text is
  preserved in the ledger's `rejected-outputs/<case-id>.<model>.rejected.txt`
  and reported as `invalid`, with the validation errors from its run-log.
  Reviewers can read it there; it is not scored with the rubric.
- Human review recorded via the existing `score` CLI command into
  `tests/gemini-quality-eval/scores/`, following `rubric.md`. Only a
  verified, mechanically valid output can be scored.
- At least one reviewer per `(case, model)` pair; cases where the rubric's
  dimension 3 (unsupported claims) is ambiguous should get a second,
  independent reviewer before a final verdict is recorded.

### How quotas, cost, and usage are bounded
- The 24-request hard cap above is enforced by the runner's request ledger
  (separate from and in addition to production's escalation budget), which
  refuses request 25.
- The runner uses only `GEMINI_QUALITY_EVAL_API_KEY`, a dedicated,
  clearly-labeled key/project (never the production `GEMINI_API_KEY`), so
  usage is separately attributable and cannot silently draw down the
  production project's quota.
- Each attempt's run-log records the case ID, model, timestamps, outcome,
  response metadata (status, finish reason, token usage) and the saved
  output's SHA-256 — never the API key and never the request. The only
  response content stored is the model's output itself (valid or rejected),
  so the 24-request ceiling is independently auditable after the fact.

### How the experiment remains isolated from production
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

### How results are evaluated without assuming Gemini 3.6 is better
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

Running the experiment (`--execute`) requires separate, explicit approval
(including provisioning a dedicated API key/project and confirming the
24-request cap) before any request is made.
