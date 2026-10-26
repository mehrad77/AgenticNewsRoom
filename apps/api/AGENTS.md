# @anr/api

Hono on Node: reads and writes for people (editor's desk, reader sites). Contract-first.

- Change `openapi.yaml` first, run `pnpm gen` (writes `src/generated/api.ts`), then implement the route in `src/app.ts`. `redocly lint` runs in `pnpm check`.
- Tenant data only through `withNewsroom()` from `@anr/db`; desk requests carry the Cloudflare Access JWT, verified before any handler.
- Every approval and edit writes an audit-log row.
- Never sends to a channel and never calls a model: publishing is the publisher's job, model calls are the agents worker's.
- Dev: `pnpm --filter @anr/api dev` → http://localhost:8787/healthz
