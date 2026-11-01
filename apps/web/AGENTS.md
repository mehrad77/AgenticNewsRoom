# @anr/web

Astro, server-rendered on Node. One app serves every newsroom's reader site and the editor's desk, routed by host in `src/middleware.ts` (`<subdomain>.$ANR_ROOT_DOMAIN` for each synced newsroom row, `desk.$ANR_ROOT_DOMAIN`). Reader pages read Postgres live as the app role, so publishing needs no rebuild.

- `<html lang dir>` comes from the page's language, never the newsroom (`directionOf` in `@anr/core`). Primary language at `/`, others at `/<lang>`.
- Reader queries (`src/lib/reader.ts`) show only `published` and `corrected` publications: row-level security separates newsrooms, not drafts.
- Every piece ends with a reader's challenge form (D114): the page posts it to the API server-side (`src/lib/challenge.ts`); the reader's status page `/challenge/<id>?k=<token>` reads Postgres like any reader page.
- Published images (`/m/<id>.<ext>`, D120) and episode audio (`/a/`) redirect to a presigned URL into the private media bucket, valid for an hour and never cached (`src/lib/storage.ts`, D132), or come from the local store in development; the desk's Images page adds images and records press-kit licences.
- Every piece is its format's `site` template rendered by `@anr/render` (label included), with schema.org JSON-LD and IPTC `digitalSourceType` in a meta tag; its ninjs 3.2 twin is the page URL plus `.json` (`src/lib/metadata.ts`).
- `@anr/*` packages stay out of the server bundle (`astro.config.mjs`), so `@anr/render` finds `config/formats`.
- The desk sits behind Cloudflare Access; verify the `Cf-Access-Jwt-Assertion` JWT before serving any desk page.
- Routing logic lives in `src/lib/` as plain TypeScript with vitest tests; `.astro` files stay thin. Each desk page is a component in `src/components/desk/`; desk styles are scoped to `body.desk`, so reader sites keep theirs.
- Dev: `pnpm --filter @anr/web dev`, then http://ai.localhost:4321/ (fa, rtl) and http://ai.localhost:4321/en (en, ltr).
- Preview on the test database: `pnpm --filter @anr/web preview:seed` (a `m4preview` newsroom in `anr_test`), then `pnpm --filter @anr/web dev:test` → http://m4preview.localhost:4410/.
