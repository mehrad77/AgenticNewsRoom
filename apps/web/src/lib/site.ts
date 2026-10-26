import { type Direction, directionOf, isLanguage, type Language } from "@anr/core";

export interface SiteNewsroom {
  slug: string;
  subdomain: string;
  languages: Language[];
  name: Partial<Record<Language, string>>;
}

export type Site =
  | { kind: "desk" }
  | {
      kind: "newsroom";
      newsroom: SiteNewsroom;
      language: Language;
      direction: Direction;
      path: string;
    }
  | { kind: "unknown" };

/**
 * Resolves a request to the editor's desk or a newsroom site and language.
 * Hosts are <subdomain>.<rootDomain>; the primary language has no prefix, others live at /<lang>.
 */
export function resolveSite(
  host: string,
  pathname: string,
  rootDomain: string,
  newsrooms: SiteNewsroom[],
): Site {
  const hostname = host.split(":")[0]?.toLowerCase() ?? "";
  const suffix = `.${rootDomain.toLowerCase()}`;
  if (!hostname.endsWith(suffix)) return { kind: "unknown" };
  const sub = hostname.slice(0, -suffix.length);
  if (sub === "desk") return { kind: "desk" };
  const newsroom = newsrooms.find((n) => n.subdomain === sub);
  if (!newsroom) return { kind: "unknown" };

  const [primary] = newsroom.languages;
  if (!primary) return { kind: "unknown" };
  const first = pathname.split("/")[1] ?? "";
  const prefixed = isLanguage(first) && first !== primary && newsroom.languages.includes(first);
  const language = prefixed ? first : primary;
  const path = prefixed ? pathname.slice(first.length + 1) || "/" : pathname;
  return { kind: "newsroom", newsroom, language, direction: directionOf(language), path };
}
