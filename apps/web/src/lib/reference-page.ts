// What a Reference page shows (D162, D170), from the newsroom's config: its home, a kind's or a
// list's index, and an entry with what it links to and what links to it. page.ts calls this.
import type { Language } from "@anr/core";
import type { Pool } from "@anr/db";
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
} from "./reference-config.ts";

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

export async function loadReference(
  pool: Pool,
  newsroomId: string,
  ref: ReferenceConfig,
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
  const incoming: Incoming[] = Object.entries(ref.kinds)
    .map(([kindKey, kind]) => ({
      kindKey,
      kind,
      entries: linking.filter((e) => e.kind === kindKey),
    }))
    .filter((g) => g.entries.length > 0);
  const incomingLinks = await linksFrom(
    pool,
    newsroomId,
    linking.map((e) => e.id),
  );
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
