# Saved model outputs (empty — no model has been called yet)

This directory is where real, saved `gemini-3.5-flash-lite` and
`gemini-3.6-flash` outputs would be placed for the 12 cases in `../cases/`,
once the Phase 5 controlled comparison (see `../README.md`) is separately
approved and run.

**As of this phase, this directory is intentionally empty.** No live Gemini
API call has been made as part of preparing this benchmark, and no output
file should be added here except a genuine saved model response.

## Expected filename convention

```
<case-id>.<model>.json
```

Example: `event-brief-01-multi-source-confirming.gemini-3.5-flash-lite.json`

Each file's content should be exactly the raw, parsed JSON the model
produced for that case's task (an `EventBrief` object, a `NarrativeDelta`
object, or a `ClaimComparison[]` array) — nothing else.

Files here are only **convenience copies**, written by the comparison runner
(`../../../scripts/run-gemini-quality-comparison.ts`, `--execute` or
`--reconcile`) from the authoritative, SHA-256-verified outputs in the shared
request ledger (`~/.local/state/ai-news-intelligence/gemini-quality-eval/outputs/`).
The report and `score` commands (`../../../scripts/gemini-quality-eval.ts`)
read the ledger, never this directory, so editing a file here changes nothing.

Do not place any response containing production data, credentials, or
anything sensitive in this directory. It is intended only for the 12
synthetic benchmark cases.
