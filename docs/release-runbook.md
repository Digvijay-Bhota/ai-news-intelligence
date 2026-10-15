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

Schema changes live in `d1/migrations/NNNN_*.sql` (0001–0015) and are applied **by hand** with
`wrangler d1 execute --file`. `workers/wrangler.toml` sets no `migrations_dir`, and the project
does not use Wrangler's migration tracking.

So `wrangler d1 migrations list` **cannot** tell you which of these files production has. The only
reliable check is to inspect the production schema for each migration's effect.

Read-only checks for recent migrations:

| Migration | Effect | Read-only check (writes nothing) | Re-runnable? |
|---|---|---|---|
| `0013_gemini_escalation_budget.sql` | creates table `gemini_escalation_budget` | `npx wrangler d1 execute ai-news-db --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name='gemini_escalation_budget';"` | yes (`CREATE TABLE IF NOT EXISTS`) |
| `0014_article_image_metadata.sql` | adds `articles_raw.image_url` and `articles_raw.image_credit` | `npx wrangler d1 execute ai-news-db --remote --command "PRAGMA table_info(articles_raw);"` | **no**: `ALTER TABLE ADD COLUMN` fails with `duplicate column name` the second time |
| `0015_article_events_event_id_index.sql` | creates index `idx_article_events_event_id` on `article_events(event_id)` | `npx wrangler d1 execute ai-news-db --remote --command "SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_article_events_event_id';"` | yes (`CREATE INDEX IF NOT EXISTS`) |

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

## Release record

### 2026-10-14 — release of `92fbd1068eec87eb84c25346b2015ebac55dbb26`

Approved by the repository owner; performed with Wrangler 3.114.17 from a clean, locked worktree
at that commit. Frontend CI and Workers CI passed on the exact commit. Times are UTC.

**Pre-release production state** (read-only checks before any write):

- Backend served `613a3ea9-d5de-427d-a224-017a7e514d33` (deployed 2026-10-10 20:00); frontend
  served `bfb3b13f-a36d-4845-bdd5-11e554c727e8` (deployed 2026-09-15 17:00). Neither records a
  source commit.
- D1: migrations 0001–0011 present (every object they create exists; their added columns exist).
  **0012 not applied** (TechCrunch and The Verge had no feed URL and were `unconfigured`, so only
  Ars Technica was ingesting), **0013 not applied** (no `gemini_escalation_budget`), **0014 not
  applied** (neither image column; not partial).
- D1 recovery bookmark captured at 10:50:24, immediately before the first write:
  `0000052a-0000000a-00005104-403332aa8a3b586af104a60d7cc5bb9c` (not used).

**Changes** (each checked immediately before and after):

| Step | Time | Before | After |
|---|---|---|---|
| Migration 0012 | 10:50 | both feed URLs `NULL` | `https://techcrunch.com/feed/`, `https://www.theverge.com/rss/index.xml`; Ars Technica unchanged |
| Migration 0013 | 10:51 | table absent | `gemini_escalation_budget` with PK `(bucket_date, model)`, `reserved_count` default 0, `updated_at` default `unixepoch()` |
| Migration 0014 | 10:51 | 13 columns, 0 of 2 image columns | `image_url` and `image_credit` present, nullable `TEXT`, no default |
| Backend deploy | 10:52 | `613a3ea9…` | `720f79d8-bc35-49e2-8e22-bf865546f635` (100%) |
| Frontend deploy | 11:07 | `bfb3b13f…` | `d87005b1-de7a-4014-bb1e-210d5f1f7d2c` (100%) |

Rollback targets if needed: backend `613a3ea9-d5de-427d-a224-017a7e514d33`, frontend
`bfb3b13f-a36d-4845-bdd5-11e554c727e8` (see E). The three migrations are additive and stay.

**Verification after the release:**

- Backend `/api/v1/health` healthy. Between the backend and frontend deploys, the previously
  deployed frontend worked against the new backend: the 12 signed `/api/*` routes tested through it
  returned 200.
- 11:00 cron: outcome `ok`, no exceptions, no errors mentioning `image_url`/`image_credit`.
  `articles_raw` grew from 453 to 483 (TechCrunch 20, The Verge 10); all three sources
  `healthy`; a new event brief at 11:06. The Verge's new articles carry `image_url` (its image
  host is allow-listed); TechCrunch's do not (not allow-listed).
- 12:00 cron: outcome `ok`, no exceptions. `articles_raw` grew from 483 to 486 (TechCrunch 1,
  The Verge 2); all three sources configured and `healthy`; 4 new event briefs (latest 12:03).
- Frontend: all routes in D returned 200; 14 data routes returned `success: true`. A headless
  Chromium session (read-only: every non-GET `/api/*` request blocked) exercised the Daily
  Briefing, Feed with Load more, topic/source/search filters and Clear All, Topics and a topic page,
  Events with Freshness/Severity/Ranking filters and Reset Filters, event detail with Community
  discussion, article detail with Key Entities, For You, Settings (not submitted) and Saved.

**Open items after this release** (none blocks it):

- Community "Load More" was not exercised live: no event has more than 50 posts. It is covered by
  `frontend/tests/community-discussion.test.tsx`.
- Index `idx_article_events_event_id` is in `d1/schema.sql` but no migration creates it, so
  production lacks it. Lookups of `article_events` by `event_id` scan the table (255 rows on
  2026-10-14).
- Table `rate_limit_logs_backup` exists in production only, apparently a manual copy of
  `rate_limit_logs` (its untyped columns match `CREATE TABLE … AS SELECT`): 4,657 rows, window
  2026-08-30 to 2026-09-18, used by no code, with IP-address-like identifiers. Its origin is
  unrecorded; keep or remove it as a separate, reviewed decision.
- Community listings inner-join `user_profiles` (`workers/src/community.ts`; the join was added
  on 2026-09-13 and this release does not change the file), so posts whose author has no profile
  are not shown: 3 of the 7 posts in production. Pre-existing; not caused by this release.
- Wrangler's `d1_migrations` table records only 0005 and 0007; do not use `d1 migrations list`.

### 2026-10-15 — release of `5362d67d4263aef4d2a565db1fc2c523cb97fa05`

Released the pipeline-run summary and stale-job recovery feature from PR #34. Workers CI and
Frontend CI passed on the exact commit. Deployed with Wrangler 3.114.17 from a clean, locked
release worktree at the exact commit. Times are UTC.

**Source and pre-release state** (read-only unless noted):

- Commit `5362d67d4263aef4d2a565db1fc2c523cb97fa05`, parent
  `95eb93a6edabf247e832bbbc84a0a4a7d14cf983`; commit tree `93f6b0c`, identical to reviewed PR head
  `90f2a360dad7821256300bd31eb70779c50836be`. No `Co-Authored-By` trailer.
- Workers CI and Frontend CI passed on the merge commit. Local validation passed: Workers
  typecheck, 51 test files / 776 tests, ledger 4 files / 64 tests; frontend lint, typecheck,
  5 test files / 66 tests, UI 10 test files / 94 tests, and production build. Lint reported one
  existing `<img>` warning in `SourceChip.tsx`; frontend code was unchanged.
- Before deploy, backend served `2ff3ff88-ad22-4dfe-bda3-689f669ffcac` and frontend served
  `d87005b1-de7a-4014-bb1e-210d5f1f7d2c`, each at 100%.
- The live frontend was not redeployed: its source matched commit `92fbd106`, the code associated
  with deployed frontend version `d87005b1-de7a-4014-bb1e-210d5f1f7d2c`.
- Required secret names were present (values not read). Production D1 contained
  `gemini_escalation_budget`, `articles_raw.image_url`, `articles_raw.image_credit`,
  `idx_pipeline_jobs_status`, and `idx_article_events_event_id`. The recovery query plan used
  `idx_pipeline_jobs_status`.
- D1 recovery bookmark captured at 12:26:04Z, before deployment:
  `00000556-00000096-00005105-f881ac29fb9b8b73e3f29a35724f63a2` (not restored).
- No migration was applied in this release. Migration 0015 and its index were already present in
  production.

**Changes and deployment**:

| Step | Time (UTC) | Before | After |
|---|---|---|---|
| Backend deploy | 12:48:53 | `2ff3ff88-ad22-4dfe-bda3-689f669ffcac` | `54f4d8da-71ff-4bf3-ab4c-26ba417970b3` (100%) |
| Frontend deploy | — | `d87005b1-de7a-4014-bb1e-210d5f1f7d2c` | Not redeployed; frontend code unchanged |

Deployment used the top-level Worker configuration, with no `--env` and no migrations. Rollback
targets are backend `2ff3ff88-ad22-4dfe-bda3-689f669ffcac` and frontend
`d87005b1-de7a-4014-bb1e-210d5f1f7d2c`. Rolling back the Worker does not reverse the stale-job
status updates described below.

**Verification after deployment**:

- Backend version `54f4d8da-71ff-4bf3-ab4c-26ba417970b3` served 100% of traffic at the final
  check. `GET /api/v1/health` returned HTTP 200 / healthy on four consecutive checks (three
  immediate and one after the cron).
- Runtime tail covered 12:50–13:14Z and captured the scheduled run. No runtime exceptions, error
  logs, or warning logs were observed. The tail disconnected before its own timeout after the cron
  had finished.
- All 18 frontend smoke checks passed against the existing frontend and newly deployed backend.
  The browser test blocked non-GET `/api/*` requests. Checks covered the briefing/feed, topics,
  events and filters, event detail and community, article detail and Key Entities, For You,
  Settings, and Saved. All 7 production community posts rendered, including 3 labelled
  “Anonymous reader”; no page errors were observed. The first script timed out on three checks
  due to assumptions in the script; follow-up checks corrected those assumptions and passed.
- The first post-deploy scheduled cron was job `4471` at 13:00Z. It ran from 13:00:09Z to
  13:01:10Z, completed with outcome `ok`, no `error_message`, and `failed_stage: null`. The
  version-1 summary was persisted to `pipeline_jobs.result`.
- **Stale-job recovery:** `stale_jobs_recovered: 3243`, matching the exact pre-deploy eligibility
  count. Pipeline-run jobs 41–4457 were marked failed with `completed_at` 13:00:09Z and the
  recovery reason. Their `result` remained null because no historic summary was available. The
  table then held 1,228 completed and 3,243 failed jobs, with none running.
- All three sources were healthy:

  | Source | Parsed | Inserted |
  |---|---:|---:|
  | Ars Technica | 20 | 0 |
  | TechCrunch | 20 | 0 |
  | The Verge | 10 | 2 |

- Processing: 2 attempted, 2 succeeded; retries: none attempted; stale articles recovered: 0.
  Brief generation covered 5 events, generated 3 briefs, and recorded 0 failed, deferred, or
  in-progress briefs. Three completed event briefs were confirmed since the cron. Two articles
  were inserted; the newest was created at 13:00:10Z.
- Per-run D1 read cost was not measured. Post-cron read-only verification used about 8.4k rows
  read and wrote nothing.

**Follow-up**:

- Verify the next scheduled hourly run; it should report `stale_jobs_recovered: 0` if no
  additional eligible stale runs accumulate.
- Per-run D1 read accounting is not implemented; investigate separately if needed.
- No D1 Time Travel restore or rollback was required.

Record each future release here in the same form.
