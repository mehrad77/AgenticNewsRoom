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
import {
  classicPapers,
  type Entry,
  entryBySlug,
  type FoundEntry,
  newsEvents,
  type ReferenceCounts,
  referenceCounts,
  searchEntries,
  str,
} from "./reference.ts";
import { REFERENCE_WORDS, type ReferenceWords } from "./reference-words.ts";
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
  ref: ReferenceWords;
  title: string;
  links: ReturnType<typeof policyUrls> & {
    search: string;
    reference: string;
    news: string;
    classics: string;
  };
  /** A path on this language's site as an absolute URL. */
  url: (path: string) => string;
  /** The same page in the newsroom's other languages, for the language switch. */
  languages: { language: Language; url: string }[];
}

export type Page =
  | { kind: "unknown" }
  | ({ kind: "not-found" } & Common)
  | ({ kind: "home"; pieces: Listed[] } & Common)
  | ({ kind: "search"; query: string; pieces: Listed[]; entries: FoundEntry[] } & Common)
  | ({
      kind: "reference";
      counts: ReferenceCounts;
      news: Entry[];
      classics: Entry[];
      label: string;
    } & Common)
  | ({
      kind: "reference-news";
      news: Entry[];
      total: number;
      filters: NewsFilters;
      label: string;
    } & Common)
  | ({ kind: "reference-classics"; classics: Entry[]; label: string } & Common)
  | ({
      kind: "reference-paper";
      entry: Entry;
      newer: Entry | null;
      older: Entry | null;
      label: string;
    } & Common)
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

export interface NewsFilters {
  org: string;
  kind: string;
  orgs: { value: string; count: number }[];
  kinds: { value: string; count: number }[];
}

/** The timeline's filters, from the query, and the values present with their counts. */
export function filterNews(
  all: Entry[],
  query: URLSearchParams,
): { news: Entry[]; filters: NewsFilters } {
  const org = query.get("org") ?? "";
  const kind = query.get("kind") ?? "";
  const count = (values: string[]) =>
    [...values.reduce((m, v) => m.set(v, (m.get(v) ?? 0) + 1), new Map<string, number>())]
      .map(([value, n]) => ({ value, count: n }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  return {
    news: all.filter((e) => (!org || e.facts.org === org) && (!kind || e.facts.news_kind === kind)),
    filters: {
      org,
      kind,
      orgs: count(all.map((e) => str(e.facts.org)).filter((x): x is string => !!x)),
      kinds: count(all.map((e) => str(e.facts.news_kind) ?? "other")),
    },
  };
}

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
  const ref = REFERENCE_WORDS[language];
  const name = newsroom.name[language] ?? newsroom.slug;
  const common = (title: string, path = "/"): Common => ({
    newsroom,
    site,
    language,
    words,
    ref,
    title: title === name ? name : `${title} · ${name}`,
    links: {
      ...policyUrls(site, language),
      search: pageUrl(site, language, "/search"),
      reference: pageUrl(site, language, "/reference"),
      news: pageUrl(site, language, "/reference/news"),
      classics: pageUrl(site, language, "/reference/classics"),
    },
    url: (p) => pageUrl(site, language, p),
    languages: newsroom.languages.map((l) => ({ language: l, url: pageUrl(site, l, path) })),
  });

  const r = route(request.path);
  // The AI label every Reference page carries next to its imported label (D164).
  const label = async () => {
    renderer ??= createRenderer();
    return renderer.disclosureLabel(language);
  };
  switch (r.kind) {
    case "home":
      return {
        kind: "home",
        pieces: await latest(deps.pool, newsroom.id, language),
        ...common(name),
      };
    case "search": {
      const query = request.query.get("q") ?? "";
      const [pieces, entries] = await Promise.all([
        search(deps.pool, newsroom.id, language, query),
        searchEntries(deps.pool, newsroom.id, query),
      ]);
      return { kind: "search", query, pieces, entries, ...common(words.search, "/search") };
    }
    case "reference": {
      const [counts, news, classics] = await Promise.all([
        referenceCounts(deps.pool, newsroom.id),
        newsEvents(deps.pool, newsroom.id),
        classicPapers(deps.pool, newsroom.id),
      ]);
      return {
        kind: "reference",
        counts,
        news: news.slice(0, 5),
        classics: classics.slice(0, 4),
        label: await label(),
        ...common(ref.reference, "/reference"),
      };
    }
    case "reference-news": {
      const all = await newsEvents(deps.pool, newsroom.id);
      const { news, filters } = filterNews(all, request.query);
      return {
        kind: "reference-news",
        news,
        total: all.length,
        filters,
        label: await label(),
        ...common(ref.news, "/reference/news"),
      };
    }
    case "reference-classics":
      return {
        kind: "reference-classics",
        classics: await classicPapers(deps.pool, newsroom.id),
        label: await label(),
        ...common(ref.classics, "/reference/classics"),
      };
    case "reference-paper": {
      const entry = await entryBySlug(deps.pool, newsroom.id, "paper", r.slug);
      if (!entry) return { kind: "not-found", ...common(words.notFound) };
      const list = entry.facts.classic ? await classicPapers(deps.pool, newsroom.id) : [];
      const at = list.findIndex((e) => e.id === entry.id);
      return {
        kind: "reference-paper",
        entry,
        newer: at > 0 ? (list[at - 1] ?? null) : null,
        older: at >= 0 ? (list[at + 1] ?? null) : null,
        label: await label(),
        ...common(entry.title, `/reference/papers/${entry.slug}`),
      };
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
        media: publication.media,
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
