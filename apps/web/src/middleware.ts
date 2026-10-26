import { defineMiddleware } from "astro:middleware";
import { newsrooms, rootDomain } from "./lib/newsrooms.ts";
import { resolveSite } from "./lib/site.ts";

export const onRequest = defineMiddleware((context, next) => {
  // Astro only trusts Host headers listed in security.allowedDomains, which is fixed at build time.
  // resolveSite is itself an allow-list (root domain + configured subdomains), so read Host directly.
  const host = context.request.headers.get("host") ?? context.url.host;
  const site = resolveSite(host, context.url.pathname, rootDomain, newsrooms);
  if (site.kind === "unknown") return new Response("Unknown site", { status: 404 });
  context.locals.site = site;
  // Every newsroom page is served by the catch-all route; the desk gets its own pages in milestone 4.
  return next(site.kind === "newsroom" ? "/newsroom" : "/desk");
});
