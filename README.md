# AI News Intelligence

Phase 0 — Foundation API

## Architecture

```
GitHub Actions
      ↓
Cloudflare Workers
      ↓
Cloudflare D1
```

## Components

- **Public API** — External-facing endpoints with HMAC authentication
- **Internal API** — Service-to-service endpoints with replay protection
- **D1 Layer** — SQLite database access layer
- **Middleware** — Rate limiting, CORS, body limits, caching

## Project Structure

```
d1/
  schema.sql      — D1 database schema
  migrate.py      — Migration helper

workers/
  src/
    index.ts           — Worker entry point
    router.ts          — Request router
    middleware/        — Auth, rate limit, CORS, body limit
    db/                — D1 access layer
    utils/             — HMAC, replay protection, cache
  tests/             — Vitest test suite
```

## Development

```bash
cd workers
npm install
npm run typecheck
npm test
```

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

> **Warning:** deploying replaces the live production Worker. Deploy only with explicit approval.

```bash
cd workers
npx wrangler deploy
```

This deploys the top-level configuration in `workers/wrangler.toml` to the Worker
`ai-news-intelligence`, the single production Worker. The frontend's `BACKEND_API`
service binding targets this Worker.

Do not use `--env production` (or any `--env`). `wrangler.toml` defines no named
environments, because they do not inherit the D1 and KV bindings. Wrangler does not
reject an undefined environment: `--env <name>` only warns, then deploys a second
Worker named `ai-news-intelligence-<name>` with the production D1 and KV bindings
and the same hourly cron.
