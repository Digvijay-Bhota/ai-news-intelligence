# Local copies of saved model outputs (empty — the comparison has not been run)

This directory holds **convenience copies** of the verified, mechanically
valid `gemini-3.5-flash-lite` and `gemini-3.6-flash` outputs for the 12
cases in `../cases/`. The comparison runner writes them here (with
`--execute` or `--reconcile`) from the authoritative copies in the shared
request ledger. The experiment has not been executed, so this directory is
empty. Do not add files here by hand.

Outputs that failed mechanical validation are never copied here. They are
preserved in the ledger's `rejected-outputs/` and reported as `invalid`.

## Expected filename convention

```
<case-id>.<model>.json
```

Example: `event-brief-01-multi-source-confirming.gemini-3.5-flash-lite.json`

Each file's content should be exactly the raw, parsed JSON the model
produced for that case's task (an `EventBrief` object, a `NarrativeDelta`
object, or a `ClaimComparison[]` array) — nothing else.

The authoritative, SHA-256-verified outputs live in the shared request
ledger (`~/.local/state/ai-news-intelligence/gemini-quality-eval/outputs/`),
written by `../../../scripts/run-gemini-quality-comparison.ts`. The report
and `score` commands (`../../../scripts/gemini-quality-eval.ts`) read the
ledger, never this directory, so editing a file here changes nothing.

Do not place any response containing production data, credentials, or
anything sensitive in this directory. It is intended only for the 12
synthetic benchmark cases.
