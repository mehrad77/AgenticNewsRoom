import type { Language } from "@anr/core";
import type { Pool } from "@anr/db";
import type { SiteNewsroom } from "./site.ts";

export const rootDomain = process.env.ANR_ROOT_DOMAIN ?? "localhost";

/** How long the host allow-list is reused before Postgres is asked again. */
const TTL_MS = 30_000;
let cached: { at: number; newsrooms: Promise<SiteNewsroom[]> } | undefined;

/** The synced newsrooms, which are the sites this app serves (config sync writes them). */
export function siteNewsrooms(pool: Pool, now = Date.now()): Promise<SiteNewsroom[]> {
  if (!cached || now - cached.at > TTL_MS) {
    const newsrooms = pool
      .query<{
        slug: string;
        subdomain: string;
        languages: Language[];
        name: Partial<Record<Language, string>>;
      }>("select slug, subdomain, languages, name from newsrooms where removed_at is null")
      .then((r) => r.rows);
    // A failed read is not cached, so the next request asks again.
    newsrooms.catch(() => {
      cached = undefined;
    });
    cached = { at: now, newsrooms };
  }
  return cached.newsrooms;
}
