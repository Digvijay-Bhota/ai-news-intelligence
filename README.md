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
