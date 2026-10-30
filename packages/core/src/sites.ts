import type { Language } from "./languages.ts";

/** The platform's own subdomains, the desk's and Grafana's; no newsroom may take one (D123). */
export const RESERVED_SUBDOMAINS = ["desk", "ops"] as const;

/** Where a newsroom's site lives (docs/technical-design.md#tenancy-and-configuration). */
export interface SiteAddress {
  subdomain: string;
  rootDomain: string;
  /** The newsroom's languages; the first is primary and served without a prefix. */
  languages: readonly Language[];
  /** Development only: the web app's port when the root domain is `localhost`. */
  devPort?: number;
}

/** The site's origin: https, except plain http on `localhost` in development. */
export function siteOrigin(site: SiteAddress): string {
  if (site.rootDomain === "localhost")
    return `http://${site.subdomain}.localhost:${site.devPort ?? 4321}`;
  return `https://${site.subdomain}.${site.rootDomain}`;
}

/** A page's absolute URL: the primary language at `/`, others at `/<language>`. */
export function pageUrl(site: SiteAddress, language: Language, path = "/"): string {
  const prefix = language === site.languages[0] ? "" : `/${language}`;
  const rest = path === "/" ? (prefix ? "" : "/") : path;
  return `${siteOrigin(site)}${prefix}${rest}`;
}

/** A publication's path inside its language's site: its series and its slot's local date (D92). */
export function publicationPath(seriesSlug: string, slot: Date, timezone: string): string {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(slot);
  return `/${seriesSlug}/${day}`;
}
