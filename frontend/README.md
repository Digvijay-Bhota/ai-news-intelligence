# AI News Intelligence — frontend

The web app, built with [vinext](https://github.com/cloudflare/vinext) (Next.js App Router on
Vite) and deployed as the Cloudflare Worker `frontend`. Its `/api/*` routes sign requests with
`HMAC_SECRET` and call the backend Worker through the `BACKEND_API` service binding
(`wrangler.toml`).

```bash
npm ci
npm run dev        # vinext dev server; put HMAC_SECRET in .dev.vars (never committed)

npm run lint       # before build: generated dist/ output is not excluded from linting
npm run typecheck
npm test           # node tests (*.test.ts)
npm run test:ui    # jsdom UI tests (*.test.tsx)
npm run build
```

Do not deploy from here without approval. Architecture, development setup and the production
release procedure are in the [root README](../README.md) and
[docs/release-runbook.md](../docs/release-runbook.md).
