# Human scorecards (empty — no output has been reviewed yet)

This directory holds human-reviewer scorecards recorded via
`../../../scripts/gemini-quality-eval.ts score ...`. Each file corresponds to
one `(case, model)` pair that has already been mechanically validated (see
`../harness.ts`'s `HumanScore` type for the exact fields) and has had a
human apply the rubric in `../rubric.md`.

## Expected filename convention

```
<case-id>.<model>.score.json
```

**As of this phase, this directory is intentionally empty**, since no model
output has been generated or reviewed yet. Do not hand-author a scorecard
without an actual saved output and an actual human review — a fabricated
score would misrepresent this evaluation's findings.
