# @anr/api

Hono on Node: reads and writes for people (editor's desk, reader sites). Contract-first.

- Change `openapi.yaml` first, run `pnpm gen` (writes `src/generated/api.ts`), then implement the route in `src/app.ts`. `redocly lint` runs in `pnpm check`.
- Tenant data only through `withNewsroom()` from `@anr/db`; desk requests carry the Cloudflare Access JWT, verified before any handler (`src/desk/access.ts`), and need a membership in the path's newsroom (D95).
- Logic lives in `src/desk/*.ts`, routes in `src/app.ts`; `*.db.test.ts` drive the app with `app.request()` against `anr_test`.
- Channel credentials are sealed with `sealCredentials()` on the way in and never returned or written to the audit log.
- Every approval and edit writes an audit-log row.
- Never sends to a channel and never calls a model: publishing is the publisher's job (a channel test is a `channel-check` job for it, D101), model calls are the agents worker's.
- The preview (`src/desk/preview.ts`) renders with the publisher's own context from `@anr/render`; `tools.db.test.ts` holds it equal to what the publisher sends (D98).
- Dev: `pnpm --filter @anr/api dev` → http://localhost:8787/healthz. On the test database, signed in as `dev@anr.test`: `pnpm --filter @anr/api dev:test` → :8788 (the web app's `dev:test` desk calls it).
- First Editor-in-Chief: `pnpm --filter @anr/api desk:grant <newsroom> <email> editor-in-chief`.
- The one platform admin (TTS engines on offer, D113): `pnpm --filter @anr/api desk:admin <email>`.
