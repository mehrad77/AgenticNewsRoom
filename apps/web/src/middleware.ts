import { defineMiddleware } from "astro:middleware";
import { startHeartbeat } from "@anr/db";
import { db } from "./lib/db.ts";
import { healthResponse } from "./lib/health.ts";
import { rootDomain, siteNewsrooms } from "./lib/newsrooms.ts";
import { resolveSite } from "./lib/site.ts";

// Started by the first request, not at import, so a build never needs a database (D128).
let heartbeat: (() => void) | undefined;

export const onRequest = defineMiddleware(async (context, next) => {
  heartbeat ??= startHeartbeat(db(), "web");
  // Before host routing: the uptime check asks the root host, which is no newsroom (D141).
  if (context.url.pathname === "/healthz") return healthResponse(db());
  // Astro only trusts Host headers listed in security.allowedDomains, which is fixed at build time.
  // resolveSite is itself an allow-list (root domain + synced newsrooms), so read Host directly.
  const host = context.request.headers.get("host") ?? context.url.host;
  const site = resolveSite(host, context.url.pathname, rootDomain, await siteNewsrooms(db()));
  if (site.kind === "unknown") return new Response("Unknown site", { status: 404 });
  context.locals.site = site;
  // The rewrite below hides it; the desk routes on the path the browser asked for.
  context.locals.path = context.url.pathname;
  // Every newsroom page is served by one route; src/lib/page.ts decides what it shows. A rewrite to
  // a bare path drops the query string, so it is carried over (site search reads `q`).
  return next(`${site.kind === "newsroom" ? "/newsroom" : "/desk"}${context.url.search}`);
});
