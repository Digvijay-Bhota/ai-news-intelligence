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

## Deployment

```bash
cd workers
npx wrangler deploy
```
