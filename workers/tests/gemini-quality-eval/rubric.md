# Gemini quality-evaluation rubric

This rubric is for a **human reviewer** comparing a saved `gemini-3.5-flash-lite`
output against a saved `gemini-3.6-flash` output for the same benchmark case
(see `cases/`). It does not call either model and is not an automated score.

## Mechanical validation vs. editorial quality — read this first

This evaluation has two independent layers, and they must not be conflated:

1. **Mechanical validation** (dimension 6 below) is produced automatically by
   `harness.ts`, which calls the exact same `validateEventBrief` /
   `validateNarrativeDelta` / `validateClaimComparisons` functions the
   production generators use. It is pass/fail. It confirms the output is
   well-formed JSON, within field-length bounds, and cites only article/source
   IDs that actually exist in the case's evidence. **It proves nothing about
   whether the content is accurate, complete, or useful.** An output can pass
   mechanical validation while being factually wrong, missing a key fact, or
   inventing a claim — the validator has no way to check any of that.
2. **Editorial quality** (dimensions 1–5 below) is a human judgment call,
   scored only after an output has passed mechanical validation. There is no
   LLM judge in this phase — a person reads the case's documented
   `must_preserve_facts` / `must_not_invent` / `known_ambiguities` and the
   output side by side.

An output that fails mechanical validation is recorded as `invalid` and is
not given editorial scores — a malformed or ungrounded output cannot be
meaningfully compared on quality.

## Scoring dimensions (1–5 human scores)

Each dimension is scored 1 (worst) to 5 (best) against the specific case's
documented facts — not a generic impression of "good writing."

### 1. Factual consistency with the supplied evidence
- **5** — Every factual claim in the output traces directly to the case's
  articles. No claim goes beyond what the evidence actually supports.
- **3** — Mostly consistent, but one minor claim is stated more strongly or
  specifically than the evidence supports (e.g. implying certainty the
  source itself hedges).
- **1** — One or more claims directly contradict the supplied evidence, or
  the output asserts something no article states.

### 2. Preservation of important information
Score against the case's `must_preserve_facts` list specifically.
- **5** — All of the case's `must_preserve_facts` are present and accurately
  represented.
- **3** — Most are present; one is omitted or materially understated.
- **1** — Multiple required facts are missing, or a fact central to the
  story (e.g. the corrected casualty count in `narrative-delta-02`) is
  dropped entirely.

### 3. Unsupported or invented claims
Score against the case's `must_not_invent` list specifically. **Treat this
dimension as a near pass/fail gate, not just one input among five** — an
invented claim is a significant quality concern regardless of how good the
rest of the output is.
- **5** — No invented or unsupported claims found.
- **2 or below** — Any item from `must_not_invent` appears in the output, or
  the output states something as fact that no article actually supports
  (e.g. naming a cause the evidence explicitly leaves undetermined, or
  merging two distinct entities as in `event-brief-04`).
- **Policy:** if this dimension scores 2 or below, record
  `overall_verdict: "fail"` for the case regardless of the other four
  scores, and list the specific invented claim(s) in `invented_claims_found`.

### 4. Correct representation of uncertainty and conflicting evidence
Score against the case's `known_ambiguities` list specifically.
- **5** — Genuine ambiguity, thin evidence, or conflicting accounts (per
  `known_ambiguities`) are explicitly and correctly represented — e.g. in
  `uncertainties`, as a `disputed`/`evolving`/`unconfirmed` status, or as a
  flagged `open_question` — matching what the case actually calls for.
- **3** — The ambiguity is acknowledged but with the wrong framing (e.g.
  labeling a genuinely evolving situation as `disputed`, or vice versa — see
  `claim-comparison-04`'s documented distinction).
- **1** — The output states a confident, settled conclusion where the
  evidence does not support one (e.g. treating `event-brief-03`'s single
  anonymous report as established fact), or ignores a documented conflict
  entirely.

### 5. Usefulness of the resulting synthesis
- **5** — A reader relying only on this output would come away genuinely
  better informed about the event, with the real complexity intact.
- **3** — Technically accurate but generic; reads as a restatement rather
  than a synthesis (e.g. a narrative delta for `narrative-delta-03` that
  manufactures a sense of change from a routine recess would score low here
  even if not factually wrong).
- **1** — Vague, repetitive, or so hedged that it conveys no actual
  information despite being schema-valid.

### 6. Structural/schema validity — mechanical, not a human score
Reported by `harness.ts` as `valid` / `invalid` with the validator's exact
error message on failure. Do not re-score this by hand; if you disagree with
a validation result, that is evidence of a bug in the harness or the real
validator, not a rubric disagreement.

## Recording a score

See `HumanScore` in `harness.ts`. Each `(case, model)` pair that has a saved,
mechanically-valid output gets one `HumanScore` record with: the five 1–5
scores above, `invented_claims_found` / `missing_facts_found` (string lists,
empty if none), a short `justification`, and an `overall_verdict` of `pass`,
`fail`, or `needs_review` (use `needs_review` when reviewers disagree or the
case's ambiguity makes a clean pass/fail call inappropriate).

## What this rubric does **not** establish

Applying this rubric to saved outputs — once they exist — will produce a
structured comparison between Lite and 3.6 **for these 12 synthetic cases**.
It will not, by itself, establish that either model is better in general: the
sample is small, synthetic, and designed to probe specific known failure
modes rather than to be statistically representative of production traffic.
See `README.md` for the larger, separately-approved comparison this phase is
designed to prepare for.
