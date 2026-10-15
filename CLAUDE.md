# AI News Intelligence — Claude Code instructions

Cloudflare-based AI news product. Architecture: `README.md`. Production releases:
`docs/release-runbook.md`.

## Layout
- `workers/` — backend Worker `ai-news-intelligence`: API, hourly ingestion cron, D1 `ai-news-db`, KV.
- `frontend/` — vinext (Next.js App Router) Worker `frontend`; reaches the backend through the
  `BACKEND_API` service binding.
- `d1/schema.sql` builds fresh databases. `d1/migrations/` are applied by hand with
  `wrangler d1 execute --file` (Wrangler migration tracking is not used).

## Commands (no package.json at the repo root; run inside each directory)
- `workers/`: `npm ci`, `npm run typecheck`, `npm test`, `npm run test:ledger`
- `frontend/`: `npm ci`, `npm run lint`, `npm run typecheck`, `npm test` (`*.test.ts`),
  `npm run test:ui` (`*.test.tsx`), `npm run build`. Run lint before build: `dist/` is not
  excluded from linting.
- Wrangler: `npx --yes wrangler@3.114.17` (the version pinned in both lockfiles).

## Rules
- Do what was asked. Read a file before editing it; prefer editing existing files and do not
  add documentation unless asked.
- Never commit secrets, `.env` files or `.dev.vars` files.
- No `Co-Authored-By` trailer on commits unless `.claude/settings.json` sets `attribution.commit`.
- Do not spawn agents unless explicitly asked.
- Follow the `workspace-disk-policy.md` project memory note. Never overwrite, delete, reset or
  clean protected worktrees, untracked files or dependency directories.

## Production safety
- No deploys, remote D1 writes, migrations, rollbacks, Time Travel restores, secret changes or
  other production mutations without explicit user approval. Follow `docs/release-runbook.md`
  for release actions.
- Production D1 is on the free tier (5M rows read per day). The limit was exceeded on
  2026-10-14, and D1-backed endpoints returned HTTP 500 until the daily reset.
- `/api/v1/health` does not query D1, so it cannot confirm that data or ingestion work.
- Keep production checks small and targeted; avoid repeated event-listing requests.

## Working efficiently
- Prefer targeted reads and searches; do not scan generated output (`dist/`, `.next/`,
  `node_modules/`) when checking source.
- Run focused tests first, then the suites above. Report the `Test Files` / `Tests` summary
  lines, not full logs.
- Keep verification to what the change needs; do not repeat checks without new evidence.
