# AI News Intelligence

An AI news product on Cloudflare: it ingests RSS sources every hour, uses Google Gemini to
enrich articles and match them to events, writes event briefs, narrative changes and claim
comparisons, and
serves them through a Next.js-style web app with personalization and community discussion.

## Architecture

```
Browser ──> frontend Worker (vinext / Next.js App Router, Cloudflare Worker "frontend")
               │  BFF routes under /api/*, HMAC-signed with HMAC_SECRET
               │  service binding BACKEND_API
               ▼
            backend Worker ("ai-news-intelligence", custom router in workers/src/router.ts)
               │  public API /api/v1/*, internal API /internal/v1/* (HMAC + replay protection)
               │  hourly cron (0 * * * *) → workers/src/tasks/orchestrator.ts runPipeline
               ▼
            D1 "ai-news-db" (binding DB) + KV (binding CACHE)
               ▲
            Google Gemini API (GEMINI_API_KEY), called from the cron pipeline
```

**Backend** (`workers/`): RSS fetch and ingestion, Gemini article enrichment and event matching,
Gemini generation (briefs, narrative deltas, claim comparisons, community signals) with model routing
and an optional, budget-limited quality escalation, public read APIs, follows, preferences,
saved and hidden items, community posts, votes and moderation. Rate limiting, CORS and body
limits live in `workers/src/middleware/`.

**Frontend** (`frontend/`): Daily Briefing homepage with the news Feed (`/`), Topics
(`/topics`, `/topics/[slug]`), Events (`/events`, `/events/[hash]` with Community discussion),
article detail with Key Entities (`/article/[id]`), For You (`/foryou`), Saved (`/saved`) and
Settings (`/settings`). Its `/api/*` routes are a backend-for-frontend that signs requests to the
backend.

**External services:** Cloudflare Workers, D1 and KV; Google Gemini.

## Project Structure

```
d1/
  schema.sql        — full schema for a fresh database (includes every migration)
  migrations/       — numbered changes for existing databases, applied by hand (see runbook)
  migrate.py        — prints the Wrangler commands
workers/            — backend Worker (wrangler.toml, src/, tests/)
frontend/           — frontend Worker (wrangler.toml, src/app, src/components, tests/)
docs/release-runbook.md — how to release to production safely
.github/workflows/  — Workers CI and Frontend CI
```

## Development

Backend:

```bash
cd workers
npm ci
npm run typecheck
npm test
```

Frontend (Frontend CI runs these in this order; lint must come before build because generated
output under `dist/` is not excluded from linting):

```bash
cd frontend
npm ci
npm run lint
npm run typecheck
npm test          # node tests (*.test.ts)
npm run test:ui   # jsdom UI tests (*.test.tsx)
npm run build
```

Local secrets go in `.dev.vars` in each Worker directory and must never be committed:
`HMAC_SECRET` for both, `GEMINI_API_KEY` for the backend.

Local development server:

```bash
cd workers
npm run dev
```

`npm run dev` runs `wrangler dev`, which uses local D1 and KV emulation by default.
Do not add `--remote`: it runs against the real Cloudflare resources.

There is no separately deployable development environment. One can be added once
dedicated development D1 and KV resources exist.

## Database setup

Run these commands from the `workers/` directory, where `wrangler.toml` is; the SQL paths are relative to it.

Migrations in `d1/migrations/` are applied by hand with `wrangler d1 execute --file`. The project
does not use Wrangler's migration tracking (`wrangler.toml` sets no `migrations_dir`), so
`wrangler d1 migrations list` does not show which of these files a database has. Check each
migration's effect in the schema instead; the runbook lists read-only checks.

### Local database

Fresh local database — `schema.sql` creates the tables and seeds the starter sources with their feed URLs:

```bash
cd workers
npx wrangler d1 execute ai-news-db --local --file=../d1/schema.sql
```

Existing local database seeded before feed URLs were added — backfill the feed URLs:

```bash
cd workers
npx wrangler d1 execute ai-news-db --local --file=../d1/migrations/0012_seed_source_feed_urls.sql
```

The backfill only fills feed URLs that are missing (NULL) or blank. A source whose feed URL
has already been set to a non-empty value is left unchanged, so customized URLs are not
overwritten and the backfill is safe to re-run.

Ars Technica is seeded without a feed URL (not yet verified), so it is skipped during ingestion.

### Remote database

> **Warning:** `--remote` runs the SQL against the real Cloudflare D1 database, not a local copy.
> Do not run these commands without explicit approval.

```bash
cd workers
npx wrangler d1 execute ai-news-db --remote --file=../d1/schema.sql
npx wrangler d1 execute ai-news-db --remote --file=../d1/migrations/0012_seed_source_feed_urls.sql
```

Use the same choice as above: `schema.sql` for a fresh database, the `0012` backfill for an existing one.

### Migration 0014: article image metadata

`d1/migrations/0014_article_image_metadata.sql` adds two nullable columns to `articles_raw`:
`image_url TEXT` and `image_credit TEXT`. They have no defaults, so existing rows keep `NULL`;
there is no backfill.

**Fresh databases:** the current `schema.sql` already creates both columns. Do **not** also apply
0014 to a database built from it.

**Existing databases** (created before 0014): check, apply exactly once, then check again.

1. Check the columns. `image_url` and `image_credit` should be **absent**:

   ```bash
   cd workers
   npx wrangler d1 execute ai-news-db --local --command "PRAGMA table_info(articles_raw);"
   ```

   If both are already listed, the migration has been applied. Do not run it. If only one is
   listed, stop and investigate before changing anything.

2. Apply the migration once:

   ```bash
   npx wrangler d1 execute ai-news-db --local --file=../d1/migrations/0014_article_image_metadata.sql
   ```

3. Check again. Both `image_url` and `image_credit` should now be listed, with no default value.

`ALTER TABLE ... ADD COLUMN` cannot be repeated: running 0014 a second time fails with a
`duplicate column name` error, which means it was already applied.

The commands above use `--local`, which only rehearses against the local D1 emulation. Running
0014 against the real database is a separate action with the same three steps:

> **Warning:** `--remote` changes the real Cloudflare D1 database. Run these only with explicit
> approval.

```bash
cd workers
npx wrangler d1 execute ai-news-db --remote --command "PRAGMA table_info(articles_raw);"   # 1. columns absent?
npx wrangler d1 execute ai-news-db --remote --file=../d1/migrations/0014_article_image_metadata.sql   # 2. once
npx wrangler d1 execute ai-news-db --remote --command "PRAGMA table_info(articles_raw);"   # 3. both columns listed?
```

**Order:** apply 0014 to the real database and verify both columns **before** deploying Worker
code that writes or reads them. That Worker inserts `image_url` and `image_credit` for every new
article, so without the columns every insert fails and ingestion stops.

**Rollback** (not tested in production):

- The previous Worker keeps working on a migrated database. Its `INSERT` names its columns
  explicitly, so the new nullable columns stay `NULL`, and its public API responses list their
  fields explicitly, so stored image metadata is not returned. (Its internal
  `POST /internal/v1/articles` response echoes the inserted row, so there it would include the two
  columns, always `NULL` for rows it creates.) The columns can stay in place.
- To stop image metadata from being stored and returned while keeping the new Worker, remove the
  source's entry from the exact-host allow-list in `workers/src/utils/image-hosts.ts`, then have the
  change reviewed and deploy it. API responses re-validate stored URLs against that list after
  every cache read, so they return `null` for both `image_url` and `image_credit` once the change
  is deployed.

## Deployment

> **Warning:** deploying replaces the live production Workers. Deploy only with explicit approval,
> following [docs/release-runbook.md](docs/release-runbook.md): pre-deployment checks, migrations,
> deployment order, smoke checks, rollback and go/no-go criteria.

Deploy order: approved D1 migrations, then the backend, then the frontend.

```bash
cd workers
npx wrangler deploy                      # backend Worker "ai-news-intelligence"

cd ../frontend
npm run build && npx wrangler deploy     # frontend Worker "frontend"
```

The backend command deploys the top-level configuration in `workers/wrangler.toml` to the Worker
`ai-news-intelligence`, the single production Worker. The frontend's `BACKEND_API`
service binding targets this Worker. The frontend build writes `frontend/.wrangler/deploy/config.json`,
which points `wrangler deploy` at the generated `frontend/dist/server/wrangler.json`.

**What is live is not necessarily `main`.** The last recorded release (2026-10-14) deployed
`92fbd106` to both Workers, after applying migrations 0012–0014 to the production database. Merges
after that commit are not live until the next release. See "Release record" in the runbook, and
recheck with its pre-deployment checks before relying on it.

Do not use `--env production` (or any `--env`). `wrangler.toml` defines no named
environments, because they do not inherit the D1 and KV bindings. Wrangler does not
reject an undefined environment: `--env <name>` only warns, then deploys a second
Worker named `ai-news-intelligence-<name>` with the production D1 and KV bindings
and the same hourly cron.
