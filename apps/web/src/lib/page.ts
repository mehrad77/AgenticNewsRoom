// Turns a request on a newsroom site into what its page shows. Plain TypeScript, so the .astro
// file only lays it out (apps/web/AGENTS.md).
import { type Language, pageUrl, type SiteAddress } from "@anr/core";
import type { Pool } from "@anr/db";
import { createRenderer } from "@anr/render";
import { type ChallengeStatus, challengeStatus } from "./challenge.ts";
import { WORDS, type Words } from "./i18n.ts";
import { jsonLd, ninjs, policyUrls } from "./metadata.ts";
import {
  corrections,
  countView,
  type Listed,
  latest,
  newsroomBySubdomain,
  publicationByPath,
  type ReaderNewsroom,
  type ReaderPublication,
  search,
} from "./reader.ts";
import { route } from "./routes.ts";

let renderer: ReturnType<typeof createRenderer> | undefined;

export interface PageDeps {
  pool: Pool;
  rootDomain: string;
  devPort?: number;
}

interface Common {
  newsroom: ReaderNewsroom;
  site: SiteAddress;
  language: Language;
  words: Words;
  title: string;
  links: ReturnType<typeof policyUrls> & { search: string };
  /** A path on this language's site as an absolute URL. */
  url: (path: string) => string;
  /** The same page in the newsroom's other languages, for the language switch. */
  languages: { language: Language; url: string }[];
}

export type Page =
  | { kind: "unknown" }
  | ({ kind: "not-found" } & Common)
  | ({ kind: "home"; pieces: Listed[] } & Common)
  | ({ kind: "search"; query: string; pieces: Listed[] } & Common)
  | ({ kind: "ai-policy" } & Common)
  | ({ kind: "corrections"; corrections: Awaited<ReturnType<typeof corrections>> } & Common)
  | ({ kind: "challenge"; challenge: ChallengeStatus } & Common)
  | ({
      kind: "publication";
      publication: ReaderPublication;
      bodyHtml: string;
      jsonLd: Record<string, unknown>;
      ninjsUrl: string;
      digitalSourceType: string;
    } & Common)
  | { kind: "ninjs"; json: Record<string, unknown> };

export async function loadPage(
  deps: PageDeps,
  request: {
    subdomain: string;
    language: Language;
    path: string;
    query: URLSearchParams;
    userAgent: string | null;
  },
): Promise<Page> {
  const newsroom = await newsroomBySubdomain(deps.pool, request.subdomain);
  if (!newsroom) return { kind: "unknown" };
  const { language } = request;
  const site = {
    subdomain: newsroom.subdomain,
    rootDomain: deps.rootDomain,
    languages: newsroom.languages,
    devPort: deps.devPort,
  };
  const words = WORDS[language];
  const name = newsroom.name[language] ?? newsroom.slug;
  const common = (title: string, path = "/"): Common => ({
    newsroom,
    site,
    language,
    words,
    title: title === name ? name : `${title} · ${name}`,
    links: { ...policyUrls(site, language), search: pageUrl(site, language, "/search") },
    url: (p) => pageUrl(site, language, p),
    languages: newsroom.languages.map((l) => ({ language: l, url: pageUrl(site, l, path) })),
  });

  const r = route(request.path);
  switch (r.kind) {
    case "home":
      return {
        kind: "home",
        pieces: await latest(deps.pool, newsroom.id, language),
        ...common(name),
      };
    case "search": {
      const query = request.query.get("q") ?? "";
      const pieces = await search(deps.pool, newsroom.id, language, query);
      return { kind: "search", query, pieces, ...common(words.search, "/search") };
    }
    case "ai-policy":
      return { kind: "ai-policy", ...common(words.aiPolicy, "/ai-policy") };
    case "corrections":
      return {
        kind: "corrections",
        corrections: await corrections(deps.pool, newsroom.id, language),
        ...common(words.corrections, "/corrections"),
      };
    case "challenge": {
      const challenge = await challengeStatus(
        deps.pool,
        newsroom.id,
        r.id,
        request.query.get("k") ?? "",
      );
      if (!challenge) return { kind: "not-found", ...common(words.notFound) };
      return { kind: "challenge", challenge, ...common(words.challenge.status, "/") };
    }
    case "publication":
    case "ninjs": {
      const publication = await publicationByPath(deps.pool, newsroom.id, language, r.path);
      if (!publication) return { kind: "not-found", ...common(words.notFound) };
      renderer ??= createRenderer();
      const links = policyUrls(site, language);
      // The site channel's template: the same renderer, label and escaping as every channel.
      const bodyHtml = await renderer.render(publication.format, "site", language, {
        rendition: publication.rendition,
        edited: publication.edited,
        ai_policy_url: links.aiPolicy,
        leads: publication.leads,
      });
      const described = { site, newsroom, publication, bodyHtml };
      if (r.kind === "ninjs") return { kind: "ninjs", json: ninjs(described) };
      await countView(deps.pool, newsroom, publication.id, request.userAgent);
      const ld = jsonLd(described);
      return {
        kind: "publication",
        publication,
        bodyHtml,
        jsonLd: ld,
        ninjsUrl: `${pageUrl(site, language, r.path)}.json`,
        digitalSourceType: (ninjs(described).digitalSourceType as { uri: string }).uri,
        // Other languages have their own publication at the same path only by coincidence.
        ...common(publication.title ?? name, "/"),
      };
    }
    default:
      return { kind: "not-found", ...common(words.notFound) };
  }
}
