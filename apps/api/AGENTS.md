# @anr/api

Hono on Node: reads and writes for people (editor's desk, reader sites). Contract-first.

- API-first (D190): a new desk or admin action is a spec change, then `pnpm gen` (writes `src/generated/api.ts` and the MCP tools in `src/generated/mcp-tools.ts`), then the route in `src/app.ts`. Give it `security: [{ cfAccess: [] }, { personalToken: [] }]` so it is an MCP tool, and `x-anr-who: editor-in-chief` when only the Editor-in-Chief may call it. `mcp-tools.test.ts` fails when a route or tool is missing. When it is a new task, add a how-to to `apps/web/src/api-howto/`. `redocly lint` runs in `pnpm check`.
- Tenant data only through `withNewsroom()` from `@anr/db`; desk requests carry the Cloudflare Access JWT, verified before any handler (`src/desk/access.ts`), or a personal token (`src/desk/tokens.ts`, D191), and need a membership in the path's newsroom (D95). A route takes its actor from `inNewsroom()` or `admin()`, so the audit log names the token. Token management calls `browserOnly()`.
- The MCP server (`src/mcp.ts`, `/mcp`) calls the API's own routes with the caller's credentials; it never reads Postgres.
- Logic lives in `src/desk/*.ts`, routes in `src/app.ts`; `*.db.test.ts` drive the app with `app.request()` against `anr_test`.
- Channel credentials are sealed with `sealCredentials()` on the way in and never returned or written to the audit log.
- Every approval and edit writes an audit-log row.
- Never sends to a channel and never calls a model: publishing is the publisher's job (a channel test is a `channel-check` job for it, D101), model calls are the agents worker's.
- The preview (`src/desk/preview.ts`) renders with the publisher's own context from `@anr/render`; `tools.db.test.ts` holds it equal to what the publisher sends (D98).
- One public write: a reader's challenge (`/reader/...`, D114), posted by the newsroom's site. It stores nothing about the reader and is rate-limited by a daily HMAC key; everything else is under `/desk/`.
- Media (`src/desk/media.ts`, D119): adding an image queues `ingest-media`; a press kit's licence is recorded once by a member, audited; the database freezes it.
- Dev: `pnpm --filter @anr/api dev` → http://localhost:8787/healthz. On the test database, signed in as `dev@anr.test`: `pnpm --filter @anr/api dev:test` → :8788 (the web app's `dev:test` desk calls it).
- First Editor-in-Chief: `pnpm --filter @anr/api desk:grant <newsroom> <email> editor-in-chief`; every later member through the desk or the API (`src/desk/members.ts`).
- The one platform admin (TTS engines on offer, D113): `pnpm --filter @anr/api desk:admin <email>` the first time; then the admin hands the role over on the Admin page (desk session only).
- The admin's models (`src/desk/models.ts`): role chains in `platform_settings` (`models.roles`, JSON null = the models file's), checked with `roleProblems` from `@anr/config`; and the local model server (LM Studio's REST API at the models file's plain-http OpenAI provider, without `/v1`), listed, loaded and unloaded; loading or unloading a model is not a model call, which stays the agents worker's. Every write is in `platform_audit_log`. `*.db.test.ts` files that set the platform admin hold `test/platform-admin.ts`'s lock.
