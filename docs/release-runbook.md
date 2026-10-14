# Release runbook

How to release `main` to production safely. This is a checklist of what must be true
before a deploy is authorized. It is **not** a statement that production is ready.

> **Every command marked "writes" changes production.** Run it only with explicit approval for
> that release. Commands marked "read-only" do not change production.

## What is deployed

| Piece | Cloudflare resource | Configuration | Deployed with |
|---|---|---|---|
| Backend API + hourly ingestion cron | Worker `ai-news-intelligence` | `workers/wrangler.toml` (top-level config only, no `[env.*]`) | `cd workers && npx wrangler deploy` |
| Frontend (vinext / Next.js App Router) | Worker `frontend` | `frontend/wrangler.toml`; the build writes `frontend/.wrangler/deploy/config.json`, which points Wrangler at the generated `frontend/dist/server/wrangler.json` | `cd frontend && npm run build && npx wrangler deploy` |
| Database | D1 `ai-news-db`, id `f174571c-041a-47aa-b59b-78e67b8fe176`, binding `DB` | `workers/wrangler.toml` | migrations applied by hand (see below) |
| Cache | KV namespace id `aa49bafbadca4a8196c164d92fb883e1`, binding `CACHE` | `workers/wrangler.toml` | — |

The frontend reaches the backend only through the service binding `BACKEND_API` →
`ai-news-intelligence`, so the backend must be deployed (and migrated) before a frontend that
depends on its changes.

**Secrets** (set with `npx wrangler secret put <NAME>` from the Worker's directory; values never
go in Git, docs, logs or PRs):

| Worker | Secret names (verified with `wrangler secret list`, 2026-10-14) |
|---|---|
| `ai-news-intelligence` | `GEMINI_API_KEY`, `HMAC_SECRET` |
| `frontend` | `HMAC_SECRET` (must match the backend's) |

Optional backend variables, unset by default: `GEMINI_MODEL_ROUTES`, `GEMINI_ESCALATION_ENABLED`,
`GEMINI_ESCALATION_DAILY_LIMIT` (`workers/src/types.ts`). With them unset, Gemini quality
escalation stays off. All other backend variables are in `[vars]` of `workers/wrangler.toml`.

### Never deploy with `--env`

`workers/wrangler.toml` defines no named environments. `--env <name>` only warns, then deploys a
**second** Worker `ai-news-intelligence-<name>` bound to the production D1 and KV, with the same
hourly cron. Deploy the top-level configuration only.

## Migrations: how this project applies them

Schema changes live in `d1/migrations/NNNN_*.sql` (0001–0014) and are applied **by hand** with
`wrangler d1 execute --file`. `workers/wrangler.toml` sets no `migrations_dir`, and the project
does not use Wrangler's migration tracking.

So `wrangler d1 migrations list` **cannot** tell you which of these files production has. The only
reliable check is to inspect the production schema for each migration's effect.

Read-only checks for the two newest migrations:

| Migration | Effect | Read-only check (writes nothing) | Re-runnable? |
|---|---|---|---|
| `0013_gemini_escalation_budget.sql` | creates table `gemini_escalation_budget` | `npx wrangler d1 execute ai-news-db --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name='gemini_escalation_budget';"` | yes (`CREATE TABLE IF NOT EXISTS`) |
| `0014_article_image_metadata.sql` | adds `articles_raw.image_url` and `articles_raw.image_credit` | `npx wrangler d1 execute ai-news-db --remote --command "PRAGMA table_info(articles_raw);"` | **no**: `ALTER TABLE ADD COLUMN` fails with `duplicate column name` the second time |

Run these from `workers/`, where `wrangler.toml` is. `ai-news-db` resolves to the
`database_id` above through that file.

## A. Pre-deployment checks (all must pass)

1. **Source.** Record the `main` SHA being released:
   `git ls-remote https://github.com/Digvijay-Bhota/ai-news-intelligence refs/heads/main`.
   Check out that exact commit. The working tree must be clean.
2. **CI.** **Frontend CI** and **Workers CI** passed on that exact commit (GitHub Actions).
3. **Authentication.** Read-only: `npx wrangler whoami` shows the account that owns the Workers above.
4. **Targets.** `workers/wrangler.toml` still names Worker `ai-news-intelligence`, D1
   `ai-news-db` / `f174571c-041a-47aa-b59b-78e67b8fe176`, and has no `[env.*]` sections. In
   `frontend/wrangler.toml`, `BACKEND_API` targets `ai-news-intelligence`.
5. **Secrets.** Read-only, names only: `npx wrangler secret list --name ai-news-intelligence` and
   `npx wrangler secret list --name frontend` list the secrets in the table above.
6. **Current versions.** Read-only: `npx wrangler deployments list --name ai-news-intelligence` and
   `npx wrangler deployments list --name frontend`. Record the version IDs now serving 100%.
   These are your rollback targets.
7. **Database state.** Run every read-only check in [Migrations](#migrations-how-this-project-applies-them)
   for each migration added since the backend version being replaced, and record the results.
8. **Database recovery point.** Read-only:
   `npx wrangler d1 time-travel info ai-news-db --timestamp <now, RFC3339>`.
   Record the bookmark it returns. It is the point you would restore to.
9. **Local validation** of the release commit:
   - `cd workers && npm ci && npm run typecheck && npm test`
   - `cd frontend && npm ci && npm run lint && npm run typecheck && npm test && npm run test:ui && npm run build`

   Lint must run before build (generated output is linted otherwise).

## B. Migration procedure (writes)

Only for migrations the read-only checks show are **missing**, approved for this release, in
numeric order:

1. Re-run the read-only check for the migration. Its effect must be fully absent. If it is
   partially present (for 0014: only one of the two columns), **stop** and investigate.
2. Read the SQL file and confirm what it does. Applying it is a separate approval.
3. Apply it once:
   `npx wrangler d1 execute ai-news-db --remote --file=../d1/migrations/<file>.sql` (writes)
4. Re-run the read-only check. The effect must now be present.

**Stop** without deploying if any migration's state is unknown, partial, or inconsistent with the
code being released.

Fresh databases are different: `d1/schema.sql` already contains every migration, so do not apply
migrations on top of it. The per-migration notes in the README (for example *Migration 0014*)
take precedence over this summary.

## C. Deployment order

1. Approved migrations (B), each verified.
2. **Backend** (writes): `cd workers && npx wrangler deploy`. Record the "Current Version ID" it prints.
3. Validate the backend (D, backend checks). If they fail, roll back the backend (E) before going on.
4. **Frontend** (writes): `cd frontend && npm run build && npx wrangler deploy`. Record the version ID.
5. Validate the frontend and its calls to the backend (D, frontend checks).
6. Record the release: `main` SHA, both version IDs, migrations applied, check results.
   Wrangler 3 `deploy` has no `--tag`/`--message`, and `VERSION` in `wrangler.toml` is not bumped
   per release, so this record is the only commit-to-version mapping.

## D. Smoke checks

Use the Workers' public URLs from the Cloudflare dashboard (they are not stored in this
repository). Read-only unless stated.

**Backend**

- `GET <backend-url>/api/v1/health` returns `status: "healthy"`. This endpoint does **not** touch
  D1, so it only proves the Worker is up.
- `npx wrangler tail ai-news-intelligence --format pretty` during the next hourly cron
  (`0 * * * *`): no insert errors. After 0014, an error naming `image_url`/`image_credit` means
  the migration is missing.
- After that cron, read-only:
  - `npx wrangler d1 execute ai-news-db --remote --command "SELECT status, COUNT(*) FROM source_health GROUP BY status;"`.
    Sources should not newly become `down`.
  - `npx wrangler d1 execute ai-news-db --remote --command "SELECT MAX(created_at) FROM articles_raw;"`
    should advance.

**Frontend** (each page loads with data, without an error message):

| Check | Route |
|---|---|
| Daily Briefing homepage, with the Feed and feed filters below it | `/` |
| Topics list, then one topic page | `/topics`, `/topics/<slug>` |
| Events: load, change Freshness/Severity/Ranking filters, Reset Filters | `/events` |
| Event detail with Community discussion (posts load; Load More if shown) | `/events/<hash>` |
| Article detail with Key Entities | `/article/<id>` |
| For You (feed or catch-up view) | `/foryou` |
| Settings (preferences and community profile load) | `/settings` |
| Saved articles | `/saved` |

Data on these pages comes through the backend binding. A page that loads but shows its error
state points at the backend, `HMAC_SECRET` mismatch, or schema.

## E. Rollback and recovery

**Worker code.** Each deploy creates a version; rollback redeploys an earlier one (writes):

```bash
npx wrangler deployments list --name <worker>                         # read-only: find the previous version ID
npx wrangler rollback <version-id> --name <worker> -m "<reason>"      # writes
npx wrangler deployments list --name <worker>                         # read-only: confirm it serves 100%
```

Roll back the frontend and backend independently, newest first.

**Database.** Rolling back a Worker does **not** roll back D1. Migrations stay applied.

- Additive migrations (new nullable columns, new tables, like 0013 and 0014) are compatible with
  the previous Worker. The README documents this for 0014. Leave them in place.
- To return D1 to an earlier point: `npx wrangler d1 time-travel restore ai-news-db --bookmark <bookmark>`
  (writes). This **discards all writes since that point**, including ingested articles, community
  posts, follows and votes. It is a last resort and requires a reviewed recovery plan.
- If a migration is **not** backward compatible (drops or renames something the running code uses),
  **stop**. Do not deploy until a reviewed recovery plan exists.

## F. Go / no-go

**No-go** if any of these is true:

- The D1 state of any migration the release depends on is unknown, partial, or inconsistent.
- A required migration is missing and not approved for this release.
- Any target differs from this document (Worker names, `database_id`, `--env` used).
- Frontend CI or Workers CI is failing or missing for the release commit.
- A required secret is missing (names above), or `BACKEND_API` does not target the backend.
- The previous version IDs or the D1 bookmark were not recorded.
- A migration is not backward compatible and there is no reviewed recovery plan.

**Go** only when every check in A passes, the migration plan in B is approved, and someone is
available to run D and E.

## Production state at the time of writing (2026-10-14)

Observed with read-only `wrangler deployments list` and the Cloudflare API. It is out of date
the moment someone deploys; recheck with A.6 and A.7.

| | Backend `ai-news-intelligence` | Frontend `frontend` |
|---|---|---|
| Serving version | `613a3ea9…`, deployed 2026-10-10 20:00 UTC | `bfb3b13f…`, deployed 2026-09-15 17:00 UTC |
| Previous version | `61f421c5…` (2026-09-18) | `20b2f6ab…` (2026-09-15) |
| Source commit | Not recorded by Cloudflare. Likely `45a753f` (main, PR #8, merged 33 minutes before the deploy). **Unconfirmed.** | Not recorded. **Unknown** |
| Merged to `main` after the deploy | 8 merges touching `workers/` or `d1/`: #9, #10, #11, #12, #13, #15, #16, #21 | 12 merges touching `frontend/`: #7, #14, #18, #19, #20, #21, #22, #23, #24, #25, #26, #27 |

**D1 (`ai-news-db`):** 38 tables (Cloudflare API). Whether **0013** and **0014** are applied is
**unknown**. Both files say they were not applied by their PRs. Run the checks in
[Migrations](#migrations-how-this-project-applies-them) before any backend deploy. The backend on
`main` writes the 0014 columns on every ingested article, so deploying it without 0014 stops
ingestion.
