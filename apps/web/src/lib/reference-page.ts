// What a Reference page shows (D162, D170), from the newsroom's config: its home, a kind's or a
// list's index, and an entry with what it links to and what links to it. page.ts calls this.
import type { Language } from "@anr/core";
import type { Pool } from "@anr/db";
import type { ReaderNewsroom } from "./reader.ts";
import {
  type Entry,
  type EntryImage,
  entriesByQid,
  entriesLinkingTo,
  entriesOf,
  entryBySlug,
  imagesOf,
  imagesOfTargets,
  kindCounts,
  linkedCounts,
  linksFrom,
  type OutLink,
  qidsIn,
  str,
} from "./reference.ts";
import {
  type KindConfig,
  type ReferenceConfig,
  type Target,
  targetByKey,
  targetOf,
  targetPath,
} from "./reference-config.ts";
import { TIMELINE_ITEM, type Timeline, timelineItems, timelineKind } from "./timeline.ts";

export interface FilterValue {
  value: string;
  count: number;
}

export interface TimelineFilter {
  fact: string;
  name: KindConfig["name"];
  selected: string;
  values: FilterValue[];
  /** Labels for values: the config's, else a name the entries carry (`<fact>_names`). */
  labels: Record<string, string>;
}

export interface HomeSection {
  target: Target;
  count: number;
  oldest: string | null;
  newest: string | null;
}

export interface Incoming {
  kindKey: string;
  kind: KindConfig;
  /** Where the group's kind lists its entries, for its filter links. */
  path: string;
  entries: Entry[];
}

export type ReferenceView =
  | { kind: "reference"; sections: HomeSection[] }
  | {
      kind: "reference-index";
      target: Target;
      entries: Entry[];
      total: number;
      filters: TimelineFilter[];
      outLinks: Map<string, OutLink[]>;
      /** For a profile index: how many entries point at each entry. */
      counts: Map<string, number>;
      /** Images: of the entries listed (by id), and of what timeline items link to (by "kind/slug"). */
      entryImages: Map<string, EntryImage>;
      targetImages: Map<string, EntryImage>;
    }
  | {
      kind: "reference-entry";
      target: Target;
      entry: Entry;
      outLinks: OutLink[];
      incoming: Incoming[];
      incomingLinks: Map<string, OutLink[]>;
      newer: Entry | null;
      older: Entry | null;
      /** Entries for the QIDs the entry's Wikidata facts name. */
      byQid: Map<string, { kind: string; slug: string }>;
      image: EntryImage | null;
      targetImages: Map<string, EntryImage>;
    };

/** The timeline's filters from the query (one parameter per fact), and the entries they keep. */
export function filterTimeline(
  kind: KindConfig,
  all: Entry[],
  query: URLSearchParams,
  language: Language,
): { entries: Entry[]; filters: TimelineFilter[] } {
  const filters = (kind.filters ?? []).map((f): TimelineFilter => {
    const counts = new Map<string, number>();
    const labels: Record<string, string> = {};
    for (const e of all) {
      const v = str(e.facts[f.fact]);
      if (!v) continue;
      counts.set(v, (counts.get(v) ?? 0) + 1);
      const own = (e.facts[`${f.fact}_names`] as Record<string, string> | undefined)?.[language];
      const configured = (f.values?.[v] as Record<string, string> | undefined)?.[language];
      labels[v] ??= configured ?? own ?? v;
    }
    return {
      fact: f.fact,
      name: f.name,
      selected: query.get(f.fact) ?? "",
      values: [...counts]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
      labels,
    };
  });
  const entries = all.filter((e) =>
    filters.every((f) => !f.selected || e.facts[f.fact] === f.selected),
  );
  return { entries, filters };
}

const factOf = (t: Target) => (t.type === "list" ? t.list.fact : undefined);

const profileKinds = (ref: ReferenceConfig) =>
  Object.entries(ref.kinds)
    .filter(([, k]) => k.layout === "profile")
    .map(([key]) => key);

/** The newest news items a news home lists, with what they link to. */
export interface HomeNews {
  target: Extract<Target, { type: "timeline" }>;
  entries: Entry[];
  outLinks: Map<string, OutLink[]>;
  targetImages: Map<string, EntryImage>;
  /** The page shown (from 1) and how many there are. */
  page: number;
  pages: number;
  /** The Reference entries the recent news names most, most named first (D182). */
  named: Named[];
}

/** A Reference entry the recent news names, with how often and its image. */
export interface Named {
  kind: string;
  slug: string;
  label: string;
  count: number;
}

/** How many of the newest items "in the news" counts over, and how many entries it shows. */
const NAMED_OVER = 60;
const NAMED_SHOWN = 12;

/** The entries the items link to, most linked first; an org's name in the page's language. */
export function mostNamed(
  entries: Entry[],
  links: Map<string, OutLink[]>,
  language: Language,
  shown = NAMED_SHOWN,
): Named[] {
  const by = new Map<string, Named>();
  for (const e of entries) {
    const orgNames = e.facts.org_names as Record<string, string> | undefined;
    for (const l of links.get(e.id) ?? []) {
      const key = `${l.toKind}/${l.toSlug}`;
      const label = (l.kind === "made-by" && orgNames?.[language]) || l.label;
      const n = by.get(key) ?? { kind: l.toKind, slug: l.toSlug, label, count: 0 };
      n.count += 1;
      by.set(key, n);
    }
  }
  return [...by.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, shown);
}

/** A news home's items (newsroom.yaml `home: {news}`): one page of the timeline, newest first. */
export async function loadHomeNews(
  pool: Pool,
  newsroom: ReaderNewsroom,
  timeline: Timeline,
  language: Language,
  limit: number,
  page: number,
): Promise<HomeNews> {
  const { entries: all, links } = await timelineItems(
    pool,
    newsroom.id,
    timeline.series,
    language,
    newsroom.timezone,
    profileKinds(newsroom.reference),
  );
  const pages = Math.max(1, Math.ceil(all.length / limit));
  const at = Math.min(Math.max(1, page), pages);
  const entries = all.slice((at - 1) * limit, at * limit);
  const named = mostNamed(all.slice(0, NAMED_OVER), links, language);
  const outLinks = new Map(entries.map((e) => [e.id, links.get(e.id) ?? []]));
  const namedLinks: OutLink[] = named.map((n) => ({
    kind: "made-by",
    label: n.label,
    toKind: n.kind,
    toSlug: n.slug,
  }));
  return {
    target: {
      type: "timeline",
      key: timeline.series,
      kind: timelineKind(timeline.config),
      kindKey: TIMELINE_ITEM,
    },
    entries,
    outLinks,
    targetImages: await imagesOfTargets(pool, newsroom.id, [...outLinks.values(), namedLinks]),
    page: at,
    pages,
    named,
  };
}

/** A series' timeline page (D173): its news items, filtered, drawn as a timeline kind's index. */
export async function loadTimeline(
  pool: Pool,
  newsroom: ReaderNewsroom,
  timeline: Timeline,
  language: Language,
  query: URLSearchParams,
): Promise<Extract<ReferenceView, { kind: "reference-index" }>> {
  const kind = timelineKind(timeline.config);
  const { entries: all, links } = await timelineItems(
    pool,
    newsroom.id,
    timeline.series,
    language,
    newsroom.timezone,
    profileKinds(newsroom.reference),
  );
  const { entries, filters } = filterTimeline(kind, all, query, language);
  return {
    kind: "reference-index",
    target: { type: "timeline", key: timeline.series, kind, kindKey: TIMELINE_ITEM },
    entries,
    total: all.length,
    filters,
    outLinks: links,
    counts: new Map(),
    entryImages: new Map(),
    targetImages: await imagesOfTargets(pool, newsroom.id, links.values()),
  };
}

export async function loadReference(
  pool: Pool,
  newsroomId: string,
  ref: ReferenceConfig,
  /** The newsroom's timelines, whose items an entry's page lists when they name it. */
  timelines: { timeline: Timeline; timezone: string }[],
  language: Language,
  r:
    | { kind: "reference" }
    | { kind: "reference-index"; path: string }
    | {
        kind: "reference-entry";
        path: string;
        slug: string;
      },
  query: URLSearchParams,
): Promise<ReferenceView | null> {
  if (r.kind === "reference") {
    const counts = new Map((await kindCounts(pool, newsroomId)).map((c) => [c.kind, c]));
    const keys = [...(ref.nav ?? []), ...Object.keys(ref.kinds)];
    const seen = new Set<string>();
    const sections: HomeSection[] = [];
    for (const key of keys) {
      const target = targetByKey(ref, key);
      if (!target || seen.has(key)) continue;
      seen.add(key);
      const c = counts.get(target.kindKey);
      if (!c) continue;
      // A card per kind and list; each opens its own page, so the home lists no entries itself.
      const count =
        target.type === "list"
          ? (await entriesOf(pool, newsroomId, target.kindKey, target.kind.layout, factOf(target)))
              .length
          : c.count;
      sections.push({ target, count, oldest: c.oldest, newest: c.newest });
    }
    return { kind: "reference", sections };
  }

  const target = targetOf(ref, r.path);
  if (!target) return null;

  if (r.kind === "reference-index") {
    const all = await entriesOf(
      pool,
      newsroomId,
      target.kindKey,
      target.kind.layout,
      factOf(target),
    );
    const { entries, filters } =
      target.kind.layout === "timeline"
        ? filterTimeline(target.kind, all, query, language)
        : { entries: all, filters: [] };
    const outLinks =
      target.kind.layout === "timeline"
        ? await linksFrom(
            pool,
            newsroomId,
            entries.map((e) => e.id),
          )
        : new Map<string, OutLink[]>();
    const counts =
      target.kind.layout === "profile"
        ? await linkedCounts(
            pool,
            newsroomId,
            entries.map((e) => e.id),
          )
        : new Map<string, number>();
    // A profile index: the most linked first.
    if (target.kind.layout === "profile")
      entries.sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0));
    return {
      kind: "reference-index",
      target,
      entries,
      total: all.length,
      filters,
      outLinks,
      counts,
      entryImages:
        target.kind.layout === "profile"
          ? await imagesOf(
              pool,
              newsroomId,
              entries.map((e) => e.id),
            )
          : new Map(),
      targetImages: await imagesOfTargets(pool, newsroomId, outLinks.values()),
    };
  }

  // A timeline's entries live on its index, and a list's entries on their kind's path.
  if (target.type !== "kind" || target.kind.layout === "timeline") return null;
  const entry = await entryBySlug(pool, newsroomId, target.kindKey, r.slug);
  if (!entry) return null;
  const [links, linking] = await Promise.all([
    linksFrom(pool, newsroomId, [entry.id]),
    entriesLinkingTo(pool, newsroomId, entry.id),
  ]);
  // News items that name the entry come first, from each timeline (D173).
  const news = await Promise.all(
    timelines.map(async ({ timeline, timezone }) => {
      const t = await timelineItems(
        pool,
        newsroomId,
        timeline.series,
        language,
        timezone,
        profileKinds(ref),
      );
      const about = t.entries.filter((e) =>
        (t.links.get(e.id) ?? []).some(
          (l) => l.toKind === target.kindKey && l.toSlug === entry.slug,
        ),
      );
      return { timeline, about, links: t.links };
    }),
  );
  const incoming: Incoming[] = [
    ...news.map(({ timeline, about }) => ({
      kindKey: TIMELINE_ITEM,
      kind: timelineKind(timeline.config),
      path: `/${timeline.config.path}`,
      entries: about,
    })),
    ...Object.entries(ref.kinds).map(([kindKey, kind]) => ({
      kindKey,
      kind,
      path: targetPath({ type: "kind", key: kindKey, kind, kindKey }),
      entries: linking.filter((e) => e.kind === kindKey),
    })),
  ].filter((g) => g.entries.length > 0);
  const incomingLinks = await linksFrom(
    pool,
    newsroomId,
    linking.map((e) => e.id),
  );
  for (const n of news) for (const e of n.about) incomingLinks.set(e.id, n.links.get(e.id) ?? []);
  // Newer and older within the list the entry belongs to, else within its kind.
  const list = Object.entries(ref.lists ?? {}).find(
    ([, l]) => l.kind === target.kindKey && entry.facts[l.fact] === true,
  );
  const siblings =
    target.kind.layout === "document"
      ? await entriesOf(pool, newsroomId, target.kindKey, "document", list?.[1].fact)
      : [];
  const at = siblings.findIndex((e) => e.id === entry.id);
  return {
    kind: "reference-entry",
    target,
    entry,
    outLinks: links.get(entry.id) ?? [],
    incoming,
    incomingLinks,
    newer: at > 0 ? (siblings[at - 1] ?? null) : null,
    older: at >= 0 ? (siblings[at + 1] ?? null) : null,
    byQid: await entriesByQid(pool, newsroomId, qidsIn(entry.facts)),
    image: (await imagesOf(pool, newsroomId, [entry.id])).get(entry.id) ?? null,
    targetImages: await imagesOfTargets(pool, newsroomId, incomingLinks.values()),
  };
}
