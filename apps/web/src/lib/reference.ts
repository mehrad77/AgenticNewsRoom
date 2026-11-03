// The Reference (D162): what its pages read from Postgres, and the plain helpers that lay entries
// out. Only listed entries are ever read; row-level security keeps each newsroom's own.
import type { Language } from "@anr/core";
import { type Pool, withNewsroom } from "@anr/db";
import { mediaPath } from "@anr/render";

export type DatePrecision = "day" | "month" | "year";

export interface EntryLink {
  label: string;
  url: string;
}

/** A paper or news entry another entry points to, or a page outside the Reference. */
export interface EntryRef {
  title: string;
  year: number | null;
  note: string | null;
  /** The note in English, when it was translated (D169). */
  noteEn: string | null;
  entry: { kind: string; slug: string } | null;
  url: string | null;
}

export interface Entry {
  id: string;
  kind: string;
  slug: string;
  title: string;
  titleLanguage: string;
  date: string | null;
  dateStatus: "verified" | "recorded" | "approximate" | null;
  facts: Record<string, unknown>;
  /** Text per language: section name to text, plus `excerpts` on classic papers. */
  body: Partial<Record<Language, Record<string, unknown>>>;
  origin: "imported" | "pipeline";
}

export interface Excerpt {
  location: string;
  original: string;
  translation: string;
  note: string;
}

interface Row {
  id: string;
  kind: string;
  slug: string;
  title: string;
  title_language: string;
  date: string | null;
  date_status: Entry["dateStatus"];
  facts: Record<string, unknown>;
  body: Entry["body"];
  origin: Entry["origin"];
}

const COLUMNS =
  "id, kind, slug, title, title_language, to_char(date, 'YYYY-MM-DD') as date, date_status, facts, body, origin";
/** The same columns of the entry aliased `e`. */
const E_COLUMNS =
  "e.id, e.kind, e.slug, e.title, e.title_language, to_char(e.date, 'YYYY-MM-DD') as date, e.date_status, e.facts, e.body, e.origin";

const entry = (r: Row): Entry => ({
  id: r.id,
  kind: r.kind,
  slug: r.slug,
  title: r.title,
  titleLanguage: r.title_language,
  date: r.date,
  dateStatus: r.date_status,
  facts: r.facts,
  body: r.body,
  origin: r.origin,
});

export interface KindCount {
  kind: string;
  count: number;
  oldest: string | null;
  newest: string | null;
}

/** How many listed entries each kind has, and its date range. */
export function kindCounts(pool: Pool, newsroomId: string): Promise<KindCount[]> {
  return withNewsroom(pool, newsroomId, async (c) => {
    const { rows } = await c.query<KindCount>(
      `select kind, count(*)::int as count,
              to_char(min(date), 'YYYY-MM-DD') as oldest, to_char(max(date), 'YYYY-MM-DD') as newest
       from reference_entries where listed group by kind`,
    );
    return rows;
  });
}

const ORDER: Record<string, string> = {
  // Newest first; on one day, the order the source recorded them in (its numeric legacy id).
  timeline: `date desc nulls last, created_at desc,
             substring(legacy_id from ':(\\d+)$')::int desc nulls first`,
  document: "date desc nulls last, slug",
  profile: "title",
};

/**
 * A kind's listed entries in its layout's order, optionally only those whose boolean `fact` is
 * true (a list, D170).
 */
export function entriesOf(
  pool: Pool,
  newsroomId: string,
  kind: string,
  layout: string,
  fact?: string,
): Promise<Entry[]> {
  return withNewsroom(pool, newsroomId, async (c) => {
    const { rows } = await c.query<Row>(
      `select ${COLUMNS} from reference_entries
       where listed and kind = $1 and ($2::text is null or (facts->>$2)::boolean)
       order by ${ORDER[layout] ?? ORDER.document}`,
      [kind, fact ?? null],
    );
    return rows.map(entry);
  });
}

export function entryBySlug(
  pool: Pool,
  newsroomId: string,
  kind: string,
  slug: string,
): Promise<Entry | null> {
  return withNewsroom(pool, newsroomId, async (c) => {
    const { rows } = await c.query<Row>(
      `select ${COLUMNS} from reference_entries where listed and kind = $1 and slug = $2`,
      [kind, slug],
    );
    return rows[0] ? entry(rows[0]) : null;
  });
}

/** A link from an entry to another, as the page shows it: the name the source wrote, linked. */
export interface OutLink {
  kind: string;
  label: string;
  toKind: string;
  toSlug: string;
}

/** The links out of these entries, by entry id; only to entries that are listed. */
export function linksFrom(
  pool: Pool,
  newsroomId: string,
  entryIds: string[],
): Promise<Map<string, OutLink[]>> {
  return withNewsroom(pool, newsroomId, async (c) => {
    const { rows } = await c.query<
      OutLink & { from_entry: string; to_kind: string; to_slug: string }
    >(
      `select l.from_entry, l.kind, l.label, t.kind as to_kind, t.slug as to_slug
       from reference_entry_links l join reference_entries t on t.id = l.to_entry
       where l.from_entry = any($1::uuid[]) and t.listed`,
      [entryIds],
    );
    const out = new Map<string, OutLink[]>();
    for (const r of rows) {
      const list = out.get(r.from_entry) ?? [];
      list.push({ kind: r.kind, label: r.label, toKind: r.to_kind, toSlug: r.to_slug });
      out.set(r.from_entry, list);
    }
    return out;
  });
}

/** The listed entries that point at an entry, newest first. */
export function entriesLinkingTo(pool: Pool, newsroomId: string, entryId: string) {
  return withNewsroom(pool, newsroomId, async (c) => {
    const { rows } = await c.query<Row>(
      `select distinct on (e.date, e.id) ${E_COLUMNS}
       from reference_entry_links l join reference_entries e on e.id = l.from_entry
       where l.to_entry = $1 and e.listed
       order by e.date desc nulls last, e.id`,
      [entryId],
    );
    return rows.map(entry);
  });
}

/** The link that names this text on an entry, if any. */
export function linkFor(links: OutLink[] | undefined, kind: string, label: string) {
  return links?.find((l) => l.kind === kind && l.label === label) ?? null;
}

export interface FoundEntry {
  kind: string;
  slug: string;
  title: string;
  date: string | null;
}

/** Site search over the Reference: the same trigram word similarity as for pieces. */
export function searchEntries(pool: Pool, newsroomId: string, query: string) {
  const q = query.trim().slice(0, 200);
  if (q.length < 2) return Promise.resolve([] as FoundEntry[]);
  return withNewsroom(pool, newsroomId, async (c) => {
    const { rows } = await c.query<FoundEntry>(
      `select kind, slug, title, to_char(date, 'YYYY-MM-DD') as date,
              word_similarity(anr.normalize_text($1), anr.normalize_text(search_text)) as score
       from reference_entries
       where listed and anr.normalize_text($1) <% anr.normalize_text(search_text)
       order by score desc, date desc nulls last limit 20`,
      [q],
    );
    return rows.map(({ kind, slug, title, date }) => ({ kind, slug, title, date }));
  });
}

// ---------------------------------------------------------------- text

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** One line of the light markup the old archive wrote: `code`, [links](url), **bold**, *italic*. */
export function inlineHtml(text: string): string {
  const codes: string[] = [];
  let out = escapeHtml(text).replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(c);
    return `\uE000${codes.length - 1}\uE000`;
  });
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_m, t: string, u: string) => `<a href="${u}" rel="noopener">${t}</a>`,
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  return out.replace(/\uE000(\d+)\uE000/g, (_m, i: string) => {
    const c = codes[Number(i)] ?? "";
    return /^https?:\/\//.test(c)
      ? `<a href="${c}" rel="noopener" dir="ltr">${c}</a>`
      : `<code>${c}</code>`;
  });
}

/** Plain text with one paragraph per line and `- ` bullets, as HTML. Escapes everything first. */
export function textHtml(text: unknown): string {
  if (typeof text !== "string" || !text.trim()) return "";
  const out: string[] = [];
  let list: string[] | null = null;
  const flush = () => {
    if (list) out.push(`<ul>${list.map((l) => `<li>${l}</li>`).join("")}</ul>`);
    list = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const bullet = /^[-•]\s+(.*)$/.exec(line);
    if (bullet?.[1] !== undefined) {
      list ??= [];
      list.push(inlineHtml(bullet[1]));
      continue;
    }
    flush();
    if (line) out.push(`<p>${inlineHtml(line)}</p>`);
  }
  flush();
  return out.join("\n");
}

/** The first sentences of a text, as plain text, for a list tile. */
export function teaser(text: unknown, max = 280): string {
  if (typeof text !== "string") return "";
  const plain = text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*`]/g, "")
    .replace(/^[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 40))}…`;
}

// ---------------------------------------------------------------- dates and groups

/** Dates on the Reference are Gregorian in every language, as the old archive wrote them. */
export function dateLabel(
  date: string | null,
  language: Language,
  precision: DatePrecision = "day",
): string {
  if (!date) return "";
  const d = new Date(`${date}T12:00:00Z`);
  const options: Intl.DateTimeFormatOptions =
    precision === "year"
      ? { year: "numeric" }
      : precision === "month"
        ? { year: "numeric", month: "long" }
        : { dateStyle: "long" };
  return new Intl.DateTimeFormat(`${language}-u-ca-gregory`, {
    ...options,
    timeZone: "UTC",
  }).format(d);
}

export const numberLabel = (n: number, language: Language) =>
  new Intl.NumberFormat(language, { useGrouping: false }).format(n);

export interface Group<T> {
  key: string;
  entries: T[];
}

/** Consecutive entries with the same key, in order. */
export function groupBy<T>(entries: T[], key: (e: T) => string): Group<T>[] {
  const out: Group<T>[] = [];
  for (const e of entries) {
    const k = key(e);
    const last = out[out.length - 1];
    if (last && last.key === k) last.entries.push(e);
    else out.push({ key: k, entries: [e] });
  }
  return out;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** The links an entry shows, from its facts, keeping only http(s) URLs. */
export function links(v: unknown): EntryLink[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (l): l is EntryLink =>
      !!l && typeof l === "object" && typeof l.url === "string" && /^https?:\/\//.test(l.url),
  );
}

export const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export function refs(v: unknown): EntryRef[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((r) => r && typeof r === "object" && typeof r.title === "string")
    .map((r) => ({
      title: r.title,
      year: typeof r.year === "number" ? r.year : null,
      note: str(r.note),
      noteEn: str(r.note_en),
      entry:
        r.entry && typeof r.entry.kind === "string" && typeof r.entry.slug === "string"
          ? { kind: r.entry.kind, slug: r.entry.slug }
          : null,
      url: str(r.url) && /^https?:\/\//.test(r.url) ? r.url : null,
    }));
}

export function excerpts(v: unknown): Excerpt[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((e) => e && typeof e === "object")
    .map((e) => ({
      location: str(e.location) ?? "",
      original: str(e.original) ?? "",
      translation: str(e.translation) ?? "",
      note: str(e.note) ?? "",
    }));
}

export { str };

/** An entry's text in the page's language, or else in the first language it has. */
export function textIn(
  entry: Entry,
  language: Language,
): { language: Language; body: Record<string, unknown> } | null {
  const own = entry.body[language];
  if (own) return { language, body: own };
  for (const l of ["fa", "en", "tr"] as const) {
    const body = entry.body[l];
    if (body) return { language: l, body };
  }
  return null;
}

/** A name in the page's language when the entry's facts carry one (`<field>_names`). */
export function nameIn(facts: Record<string, unknown>, field: string, language: Language) {
  const names = facts[`${field}_names`];
  const own =
    names && typeof names === "object" ? (names as Record<string, unknown>)[language] : null;
  return str(own) ?? str(facts[field]);
}

/** The language an entry's text is first written in, then the rest, for fallbacks. */
const FALLBACK: readonly Language[] = ["fa", "en", "tr"];

/**
 * Each named section in the page's language, or else in the first language that has it: an entry
 * translated only in part still shows every section (D169).
 */
export function sectionsIn(
  entry: Entry,
  language: Language,
  names: readonly string[],
): { name: string; language: Language; text: string }[] {
  const order = [language, ...FALLBACK.filter((l) => l !== language)];
  return names.flatMap((name) => {
    for (const l of order) {
      const text = entry.body[l]?.[name];
      if (typeof text === "string" && text.trim()) return [{ name, language: l, text }];
    }
    return [];
  });
}

/** How many listed entries point at each of these entries. */
export function linkedCounts(
  pool: Pool,
  newsroomId: string,
  entryIds: string[],
): Promise<Map<string, number>> {
  return withNewsroom(pool, newsroomId, async (c) => {
    const { rows } = await c.query<{ to_entry: string; n: number }>(
      `select l.to_entry, count(distinct l.from_entry)::int as n
       from reference_entry_links l join reference_entries f on f.id = l.from_entry
       where l.to_entry = any($1::uuid[]) and f.listed group by l.to_entry`,
      [entryIds],
    );
    return new Map(rows.map((r) => [r.to_entry, r.n]));
  });
}

/** An entry's name in the page's language (`facts.names`), else its title as the source wrote it. */
export function entryName(entry: Pick<Entry, "facts" | "title">, language: Language): string {
  const names = entry.facts.names as Partial<Record<Language, string>> | undefined;
  return names?.[language] ?? entry.title;
}

/** Listed entries by their Wikidata QID (`facts.qid`), so a profile links the people and places it names. */
export function entriesByQid(
  pool: Pool,
  newsroomId: string,
  qids: string[],
): Promise<Map<string, { kind: string; slug: string }>> {
  if (qids.length === 0) return Promise.resolve(new Map());
  return withNewsroom(pool, newsroomId, async (c) => {
    const { rows } = await c.query<{ qid: string; kind: string; slug: string }>(
      `select facts->>'qid' as qid, kind, slug from reference_entries
       where listed and facts->>'qid' = any($1::text[])`,
      [qids],
    );
    return new Map(rows.map((r) => [r.qid, { kind: r.kind, slug: r.slug }]));
  });
}

/** The QIDs a profile's Wikidata facts name (founders, parent, employer…). */
export function qidsIn(facts: Record<string, unknown>): string[] {
  const wd = facts.wikidata as Record<string, unknown> | undefined;
  if (!wd) return [];
  return Object.values(wd).flatMap((v) =>
    Array.isArray(v)
      ? v.flatMap((x) => (x && typeof x === "object" && typeof x.qid === "string" ? [x.qid] : []))
      : [],
  );
}

/** An entry's links out, or none. */
export const linkedOrNull = (links: Map<string, OutLink[]>, entryId: string): OutLink[] =>
  links.get(entryId) ?? [];

/** An entry's image as the site shows it: its published copy (D120), with credit and licence. */
export interface EntryImage {
  src: string;
  width: number | null;
  height: number | null;
  alt: string;
  credit: string;
  licence: string;
  licenceUrl: string | null;
  sourceUrl: string | null;
}

/** The images of these entries that have a published copy, by entry id (D119). */
export function imagesOf(
  pool: Pool,
  newsroomId: string,
  entryIds: string[],
): Promise<Map<string, EntryImage>> {
  if (entryIds.length === 0) return Promise.resolve(new Map());
  return withNewsroom(pool, newsroomId, async (c) => {
    const { rows } = await c.query<{
      entry: string;
      id: string;
      content_type: string;
      width: number | null;
      height: number | null;
      description: string | null;
      credit_line: string;
      licence: string;
      licence_url: string | null;
      source_url: string | null;
    }>(
      `select e.id as entry, m.id, m.content_type, (e.facts->'image'->>'width')::int as width,
              (e.facts->'image'->>'height')::int as height, m.description, m.credit_line,
              m.licence, m.licence_url, m.source_url
       from reference_entries e
       join media m on m.id::text = e.facts->'image'->>'media_id'
       where e.id = any($1::uuid[]) and m.published_file is not null
         and m.licence is not null and nullif(trim(m.credit_line), '') is not null`,
      [entryIds],
    );
    return new Map(
      rows.map((r) => [
        r.entry,
        {
          src: mediaPath(r.id, r.content_type),
          width: r.width,
          height: r.height,
          alt: r.description ?? "",
          credit: r.credit_line,
          licence: r.licence,
          licenceUrl: r.licence_url,
          sourceUrl: r.source_url,
        },
      ]),
    );
  });
}

/** The images of the entries these links point at, by "kind/slug". */
export async function imagesOfTargets(
  pool: Pool,
  newsroomId: string,
  links: Iterable<OutLink[]>,
): Promise<Map<string, EntryImage>> {
  const targets = [...new Set([...links].flat().map((l) => `${l.toKind}/${l.toSlug}`))];
  if (targets.length === 0) return new Map();
  const ids = await withNewsroom(pool, newsroomId, async (c) => {
    const { rows } = await c.query<{ id: string; ks: string }>(
      `select id, kind || '/' || slug as ks from reference_entries
       where kind || '/' || slug = any($1::text[]) and facts ? 'image'`,
      [targets],
    );
    return rows;
  });
  const images = await imagesOf(
    pool,
    newsroomId,
    ids.map((r) => r.id),
  );
  return new Map(
    ids.flatMap((r) => {
      const img = images.get(r.id);
      return img ? [[r.ks, img] as const] : [];
    }),
  );
}
