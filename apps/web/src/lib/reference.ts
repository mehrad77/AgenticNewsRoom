// The Reference (D162): what its pages read from Postgres, and the plain helpers that lay entries
// out. Only listed entries are ever read; row-level security keeps each newsroom's own.
import type { Language } from "@anr/core";
import { type Pool, withNewsroom } from "@anr/db";

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

/** Classic papers are paper entries with `facts.classic`. */
const CLASSIC = "kind = 'paper' and (facts->>'classic')::boolean";

export interface ReferenceCounts {
  news: number;
  classics: number;
  newsOldest: string | null;
  newsNewest: string | null;
}

export function referenceCounts(pool: Pool, newsroomId: string): Promise<ReferenceCounts> {
  return withNewsroom(pool, newsroomId, async (c) => {
    const { rows } = await c.query<{
      news: number;
      classics: number;
      oldest: string | null;
      newest: string | null;
    }>(
      `select count(*) filter (where kind = 'news-event')::int as news,
              count(*) filter (where ${CLASSIC})::int as classics,
              to_char(min(date) filter (where kind = 'news-event'), 'YYYY-MM-DD') as oldest,
              to_char(max(date) filter (where kind = 'news-event'), 'YYYY-MM-DD') as newest
       from reference_entries where listed`,
    );
    const r = rows[0];
    return {
      news: r?.news ?? 0,
      classics: r?.classics ?? 0,
      newsOldest: r?.oldest ?? null,
      newsNewest: r?.newest ?? null,
    };
  });
}

/** The news timeline, newest first; the same day keeps the order the entries were recorded in. */
export function newsEvents(pool: Pool, newsroomId: string): Promise<Entry[]> {
  return withNewsroom(pool, newsroomId, async (c) => {
    const { rows } = await c.query<Row>(
      `select ${COLUMNS} from reference_entries
       where listed and kind = 'news-event'
       order by date desc nulls last, created_at desc,
                substring(legacy_id from '^lab-news:(\\d+)$')::int desc nulls first`,
    );
    return rows.map(entry);
  });
}

/** Classic papers, newest first, as the old archive listed them. */
export function classicPapers(pool: Pool, newsroomId: string): Promise<Entry[]> {
  return withNewsroom(pool, newsroomId, async (c) => {
    const { rows } = await c.query<Row>(
      `select ${COLUMNS} from reference_entries
       where listed and ${CLASSIC}
       order by date desc nulls last, slug`,
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

/** An entry's path on the site: papers have pages, news events are anchors on the timeline. */
export function entryPath(kind: string, slug: string): string {
  if (kind === "news-event") return `/reference/news#${slug}`;
  if (kind === "paper") return `/reference/papers/${slug}`;
  return `/reference/${kind}/${slug}`;
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
