# @anr/web

Astro, server-rendered on Node. One app serves every newsroom's reader site and the editor's desk, routed by host in `src/middleware.ts` (`<subdomain>.$ANR_ROOT_DOMAIN`, `desk.$ANR_ROOT_DOMAIN`). Reader pages read Postgres live, so publishing needs no rebuild.

- `<html lang dir>` comes from the page's language, never the newsroom (`directionOf` in `@anr/core`). Primary language at `/`, others at `/<lang>`.
- Every piece shows the AI-disclosure label and carries IPTC `digitalSourceType` in meta tags and JSON-LD.
- The desk sits behind Cloudflare Access; verify the `Cf-Access-Jwt-Assertion` JWT before serving any desk page.
- Routing logic lives in `src/lib/` as plain TypeScript with vitest tests; `.astro` files stay thin.
- Dev: `pnpm --filter @anr/web dev`, then http://ai.localhost:4321/ (fa, rtl) and http://ai.localhost:4321/en (en, ltr).
