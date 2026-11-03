// Turns a request on a newsroom site into what its page shows. Plain TypeScript, so the .astro
// file only lays it out (apps/web/AGENTS.md).
import { type Language, pageUrl, type SiteAddress, siteOrigin } from "@anr/core";
import type { Pool } from "@anr/db";
import { audioPath, chapterTitles, createRenderer } from "@anr/render";
import { type ChallengeStatus, challengeStatus } from "./challenge.ts";
import { type EpisodeView, episodeView, type Picture, portraitsOf } from "./episode.ts";
import { WORDS, type Words } from "./i18n.ts";
import { jsonLd, ninjs, policyUrls } from "./metadata.ts";
import { episodeFacts } from "./podcast.ts";
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
import { entryName, type FoundEntry, searchEntries } from "./reference.ts";
import {
  entryPath,
  hasReference,
  nameOf,
  type ReferenceConfig,
  targetByKey,
  targetNames,
  targetPath,
} from "./reference-config.ts";
import {
  type HomeNews,
  loadHomeNews,
  loadReference,
  loadTimeline,
  type ReferenceView,
} from "./reference-page.ts";
import { REFERENCE_WORDS, type ReferenceWords } from "./reference-words.ts";
import { route } from "./routes.ts";
import { artwork, coverOf } from "./series.ts";
import { TIMELINE_ITEM } from "./timeline.ts";

let renderer: ReturnType<typeof createRenderer> | undefined;

/**
 * An episode's notes on its page: an imported episode's summary and chapters (D177), else the
 * chapters of its script.
 */
export function showNotes(rendition: Record<string, unknown>): string {
  const chapters = Array.isArray(rendition.chapters)
    ? (rendition.chapters as { title?: string }[]).map((c) => c.title ?? "").filter(Boolean)
    : chapterTitles(rendition);
  return [typeof rendition.summary === "string" ? rendition.summary : "", chapters.join(" · ")]
    .filter(Boolean)
    .join("\n\n");
}

/** The format whose publications are episodes, drawn with a player (D181). */
const EPISODE_FORMAT = "podcast-episode";

/** How many news items a news home lists before its link to the whole timeline. */
const HOME_NEWS = 30;
/** How many of the other series' pieces a news home lists under its news. */
const HOME_PIECES = 8;

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
  links: ReturnType<typeof policyUrls> & { search: string; reference: string };
  /**
   * The header's sections after the latest pieces: each series' timeline (D173), then the
   * Reference's nav (reference.yaml).
   */
  referenceNav: { key: string; href: string; label: string }[];
  /** An entry's URL on this language's site, or null when the newsroom has no such kind. */
  entryUrl: (kind: string, slug: string) => string | null;
  /** A path on this language's site as an absolute URL. */
  url: (path: string) => string;
  /** The same page in the newsroom's other languages, for the language switch. */
  languages: { language: Language; url: string }[];
}

export type Page =
  | { kind: "unknown" }
  | ({ kind: "not-found" } & Common)
  | ({
      kind: "home";
      pieces: Listed[];
      /** On a news home (newsroom.yaml `home: {news}`): the newest items, the pieces under them. */
      news: (HomeNews & { label: string }) | null;
    } & Common)
  | ({ kind: "search"; query: string; pieces: Listed[]; entries: FoundEntry[] } & Common)
  | (ReferenceView & { label: string; reference: ReferenceConfig } & Common)
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
      /**
       * An episode with audio, drawn by EpisodePage.astro instead of the body (D181): its player,
       * transcript, AI label (edited or not) and the series' feed.
       */
      episode:
        | (EpisodeView & {
            label: string;
            feedUrl: string;
            /** Its cover, else the show art; the show art is also the player's artwork (D180). */
            cover: Picture | null;
            showArt: Picture | null;
            /** Each speaker's portrait, when the series has one for them. */
            portraits: Record<string, Picture>;
          })
        | null;
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
    },
    referenceNav: [
      ...newsroom.timelines.map((t) => ({
        key: t.series,
        href: pageUrl(site, language, `/${t.config.path}`),
        label: nameOf(t.config.name, language),
      })),
      ...(newsroom.reference.nav ?? []).flatMap((key) => {
        const t = targetByKey(newsroom.reference, key);
        return t
          ? [
              {
                key,
                href: pageUrl(site, language, targetPath(t)),
                label: nameOf(targetNames(t).name, language),
              },
            ]
          : [];
      }),
    ],
    entryUrl: (kind, slug) => {
      // A news item lives on its series' timeline.
      const timeline = newsroom.timelines[0];
      if (kind === TIMELINE_ITEM)
        return timeline ? pageUrl(site, language, `/${timeline.config.path}#${slug}`) : null;
      const p = entryPath(newsroom.reference, kind, slug);
      return p ? pageUrl(site, language, p) : null;
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
    case "home": {
      const home = newsroom.home;
      const timeline =
        typeof home === "object" ? newsroom.timelines.find((t) => t.series === home.news) : null;
      if (!timeline)
        return {
          kind: "home",
          pieces: await latest(deps.pool, newsroom.id, language),
          news: null,
          ...common(name),
        };
      const [news, pieces] = await Promise.all([
        loadHomeNews(
          deps.pool,
          newsroom,
          timeline,
          language,
          HOME_NEWS,
          Number(request.query.get("page")) || 1,
        ),
        latest(deps.pool, newsroom.id, language, HOME_PIECES, [timeline.series]),
      ]);
      return { kind: "home", pieces, news: { ...news, label: await label() }, ...common(name) };
    }
    case "search": {
      const query = request.query.get("q") ?? "";
      const [pieces, entries] = await Promise.all([
        search(deps.pool, newsroom.id, language, query),
        searchEntries(deps.pool, newsroom.id, query),
      ]);
      return { kind: "search", query, pieces, entries, ...common(words.search, "/search") };
    }
    case "timeline": {
      const timeline = newsroom.timelines.find((t) => t.config.path === r.path);
      if (!timeline) return { kind: "not-found", ...common(words.notFound) };
      const view = await loadTimeline(deps.pool, newsroom, timeline, language, request.query);
      return {
        ...view,
        label: await label(),
        reference: newsroom.reference,
        ...common(nameOf(timeline.config.name, language), request.path),
      };
    }
    case "reference":
    case "reference-index":
    case "reference-entry": {
      if (!hasReference(newsroom.reference))
        return { kind: "not-found", ...common(words.notFound) };
      const view = await loadReference(
        deps.pool,
        newsroom.id,
        newsroom.reference,
        newsroom.timelines.map((timeline) => ({ timeline, timezone: newsroom.timezone })),
        language,
        r,
        request.query,
      );
      if (!view) return { kind: "not-found", ...common(words.notFound) };
      const title =
        view.kind === "reference"
          ? ref.reference
          : view.kind === "reference-entry"
            ? entryName(view.entry, language)
            : nameOf(targetNames(view.target).name, language);
      return {
        ...view,
        label: await label(),
        reference: newsroom.reference,
        ...common(title, request.path),
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
      const audioUrl = `${siteOrigin(site)}${audioPath(publication.id)}`;
      // The site channel's template: the same renderer, label and escaping as every channel.
      const bodyHtml = await renderer.render(publication.format, "site", language, {
        rendition: publication.rendition,
        edited: publication.edited,
        ai_policy_url: links.aiPolicy,
        leads: publication.leads,
        media: publication.media,
        // An episode's audio, through the counting redirect, and its notes (D110, D177).
        audio_url: audioUrl,
        show_notes: showNotes(publication.rendition),
      });
      const described = { site, newsroom, publication, bodyHtml };
      if (r.kind === "ninjs") return { kind: "ninjs", json: ninjs(described) };
      await countView(deps.pool, newsroom, publication.id, request.userAgent);
      const ld = jsonLd(described);
      const facts =
        publication.format === EPISODE_FORMAT
          ? await episodeFacts(deps.pool, newsroom, publication.id)
          : null;
      let episode: (Page & { kind: "publication" })["episode"] = null;
      if (facts) {
        const view = episodeView({ rendition: publication.rendition, audioUrl, ...facts });
        const [art, cover] = await Promise.all([
          artwork(deps.pool, newsroom.id, `series/${publication.series}/`),
          coverOf(deps.pool, newsroom.id, publication.rendition),
        ]);
        const showArt = art.get("show") ?? null;
        episode = {
          ...view,
          label: await renderer.disclosureLabel(language, publication.edited),
          feedUrl: pageUrl(site, language, `/podcast/${publication.series}.xml`),
          cover: cover ?? showArt,
          showArt,
          portraits: portraitsOf(art, Object.keys(view.speakers)),
        };
      }
      return {
        kind: "publication",
        publication,
        bodyHtml,
        jsonLd: ld,
        ninjsUrl: `${pageUrl(site, language, r.path)}.json`,
        digitalSourceType: (ninjs(described).digitalSourceType as { uri: string }).uri,
        episode,
        // Other languages have their own publication at the same path only by coincidence.
        ...common(publication.title ?? name, "/"),
      };
    }
    default:
      return { kind: "not-found", ...common(words.notFound) };
  }
}
