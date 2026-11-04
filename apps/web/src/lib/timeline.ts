// A series' news items as a timeline (D173): every news item of its published pieces in one
// language, newest first, each an anchor on the timeline page that links to its piece. Items are
// shaped like timeline entries, so the Reference's timeline layout draws them, and the names they
// carry (`org`, `related`) link to the Reference entries that bear them.
import { itemHash, type Language } from "@anr/core";
import { type Pool, withNewsroom } from "@anr/db";
import type { Entry, OutLink } from "./reference.ts";
import type { KindConfig, Names } from "./reference-config.ts";

export interface TimelineConfig {
  path: string;
  name: Names;
  intro?: Names;
  filters?: KindConfig["filters"];
}

export interface Timeline {
  series: string;
  config: TimelineConfig;
}

/** The kind a timeline is drawn as: the Reference's timeline layout, grouped by year and day. */
export const timelineKind = (t: TimelineConfig): KindConfig => ({
  path: t.path,
  layout: "timeline",
  name: t.name,
  one: t.name,
  intro: t.intro,
  grouping: "year-day",
  filters: t.filters,
});

/** The kind key of timeline items, as a target's `kindKey`. */
export const TIMELINE_ITEM = "timeline-item";

/** The kind a series' timeline items carry, so a link to one resolves to that series' timeline. */
export const timelineItemKind = (series: string) => `${TIMELINE_ITEM}:${series}`;

/** The series a timeline item's kind names, or null for any other kind. */
export const timelineSeriesOf = (kind: string): string | null =>
  kind.startsWith(`${TIMELINE_ITEM}:`) ? kind.slice(TIMELINE_ITEM.length + 1) : null;

interface Item {
  kind?: string;
  headline?: string;
  body?: string;
  claim_ids?: string[];
  org?: string;
  news_kind?: string;
  related?: string[];
  url?: string;
  url_type?: string;
  links?: { url: string; label: string }[];
  anchor?: string;
  approximate?: boolean;
}

/** A headline in Latin script in a non-Latin piece is the source's own (English) title. */
const LATIN_ONLY = /^[\p{Script=Latin}\p{N}\p{P}\p{S}\s]+$/u;
const LATIN_LANGUAGES = new Set(["en", "tr"]);

/** The items of one piece, as timeline entries; `leadUrl` is the item's first claim's lead. */
export function itemsOf(
  piece: {
    id: string;
    series: string;
    path: string;
    day: string;
    origin: string;
    items: Item[];
    /** An imported piece's items the gate checked (D184): item path to the text's hash then. */
    checked?: Record<string, string>;
  },
  language: Language,
  leadUrl: (claimId: string) => string | undefined,
): Entry[] {
  return piece.items.flatMap((item, i) => {
    if (item.kind !== "news" || !item.headline) return [];
    const links = item.links ?? [];
    return [
      {
        id: `${piece.id}:${i}`,
        kind: timelineItemKind(piece.series),
        slug: item.anchor ?? `${piece.day}-${i + 1}`,
        title: item.headline,
        titleLanguage:
          LATIN_ONLY.test(item.headline) && !LATIN_LANGUAGES.has(language) ? "en" : language,
        date: piece.day,
        dateStatus: item.approximate ? "approximate" : "verified",
        facts: {
          org: item.org,
          news_kind: item.news_kind,
          url: item.url ?? (item.claim_ids ?? []).map(leadUrl).find(Boolean),
          url_type: item.url_type,
          links: links.filter((l) => l.label !== "telegram"),
          telegram: links.filter((l) => l.label === "telegram").map((l) => l.url),
          piece: piece.path,
          related: item.related ?? [],
        },
        body: { [language]: { summary: item.body ?? "" } },
        // An imported item is labelled until the gate checked it as it reads now (D184).
        origin:
          piece.origin === "imported" &&
          piece.checked?.[`items.${i}`] !== itemHash(item as Record<string, unknown>)
            ? "imported"
            : "pipeline",
      },
    ];
  });
}

interface NamedEntry {
  kind: string;
  slug: string;
  /** The entry's name per language. */
  names: Record<string, string>;
}

/** A lower-cased name to the profile entry that bears it: title, names per language, aliases. */
export function nameIndex(
  rows: { kind: string; slug: string; title: string; facts: Record<string, unknown> }[],
): Map<string, NamedEntry> {
  const out = new Map<string, NamedEntry>();
  for (const r of rows) {
    const names = Object.values((r.facts.names as Record<string, string> | undefined) ?? {});
    const aliases = (r.facts.aliases as string[] | undefined) ?? [];
    for (const n of [r.title, ...names, ...aliases])
      if (typeof n === "string" && n.trim() && !out.has(n.trim().toLowerCase()))
        out.set(n.trim().toLowerCase(), {
          kind: r.kind,
          slug: r.slug,
          names: (r.facts.names as Record<string, string> | undefined) ?? {},
        });
  }
  return out;
}

/**
 * An item's links: its `org` as made-by, its `related` names as mentions. A linked `org` takes the
 * entry's names (`org_names`), so the timeline shows it in the page's language.
 */
export function linksOf(entry: Entry, names: Map<string, NamedEntry>): OutLink[] {
  const out: OutLink[] = [];
  const add = (kind: string, label: unknown) => {
    if (typeof label !== "string") return;
    const to = names.get(label.trim().toLowerCase());
    if (to) out.push({ kind, label, toKind: to.kind, toSlug: to.slug });
  };
  add("made-by", entry.facts.org);
  const org =
    typeof entry.facts.org === "string" && names.get(entry.facts.org.trim().toLowerCase());
  if (org) entry.facts.org_names = org.names;
  for (const r of (entry.facts.related as string[]) ?? []) add("mentions", r);
  return out;
}

/** Every news item of a series' published pieces in a language, newest first, with its links. */
export function timelineItems(
  pool: Pool,
  newsroomId: string,
  series: string,
  language: Language,
  timezone: string,
  /** The Reference's profile kinds, whose entries an item's names link to. */
  profileKinds: string[],
): Promise<{ entries: Entry[]; links: Map<string, OutLink[]> }> {
  return withNewsroom(pool, newsroomId, async (c) => {
    const { rows } = await c.query<{
      id: string;
      path: string;
      day: string;
      origin: string;
      story_id: string;
      items: Item[] | null;
      checked: Record<string, string> | null;
    }>(
      `select p.id, p.path, to_char(p.slot at time zone $3, 'YYYY-MM-DD') as day, p.origin,
              r.story_id, r.body->'items' as items,
              (select jsonb_object_agg(ci.item, ci.text_hash) from checked_items ci
               where ci.publication_id = p.id) as checked
       from publications p
       join series s on s.id = p.series_id
       join publication_renditions pr on pr.publication_id = p.id and pr.position = 1
       join renditions r on r.id = pr.rendition_id
       where s.slug = $1 and p.language = $2 and p.status in ('published', 'corrected')
       order by p.slot desc`,
      [series, language, timezone],
    );
    const { rows: claims } = await c.query<{ story_id: string; ref: string; uri: string }>(
      `select c.story_id, c.ref, l.uri from claims c join leads l on l.id = c.lead_id
       where c.story_id = any($1::uuid[]) and c.ref is not null`,
      [rows.map((r) => r.story_id)],
    );
    const leadUrl = new Map(claims.map((x) => [`${x.story_id}:${x.ref}`, x.uri]));
    const { rows: profiles } = await c.query<{
      kind: string;
      slug: string;
      title: string;
      facts: Record<string, unknown>;
    }>(
      `select kind, slug, title, facts from reference_entries
       where listed and kind = any($1::text[])`,
      [profileKinds],
    );
    const names = nameIndex(profiles);
    const entries = rows.flatMap((r) =>
      itemsOf({ ...r, series, items: r.items ?? [], checked: r.checked ?? {} }, language, (id) =>
        leadUrl.get(`${r.story_id}:${id}`),
      ),
    );
    return { entries, links: new Map(entries.map((e) => [e.id, linksOf(e, names)])) };
  });
}
