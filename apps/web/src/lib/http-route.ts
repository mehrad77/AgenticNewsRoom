// The route a request's trace and duration metric are named by (D137): a template, never the path
// itself, so a series, a date or an id does not make a new series of metrics.
import { mediaRoute } from "./media.ts";
import { podcastRoute } from "./podcast.ts";
import { route } from "./routes.ts";
import type { Site } from "./site.ts";

const TEMPLATES = {
  home: "/",
  search: "/search",
  "ai-policy": "/ai-policy",
  corrections: "/corrections",
  challenge: "/challenge/:id",
  publication: "/:series/:date",
  ninjs: "/:series/:date.json",
  "not-found": "/*",
} as const;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

export function httpRoute(site: Site, path: string): string {
  if (site.kind === "desk")
    return `/desk${path.replace(UUID, ":id").replace(/^\/newsrooms\/[^/]+/, "/newsrooms/:newsroom")}`;
  if (site.kind !== "newsroom") return "/*";
  const podcast = podcastRoute(site.path);
  if (podcast) return podcast.kind === "audio" ? "/a/:id.mp3" : "/podcast/:series.xml";
  if (mediaRoute(site.path)) return "/m/:id";
  return TEMPLATES[route(site.path).kind];
}
