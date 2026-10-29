// What a reader site reads from Postgres. Every query runs inside withNewsroom() as the app role,
// and every one is limited to published and corrected publications: row-level security separates
// newsrooms, not drafts from published pieces.
import type { Language } from "@anr/core";
import { type Pool, withNewsroom } from "@anr/db";
import { type MediaContext, mediaContext } from "@anr/render";

/** The statuses a reader may see; also the predicate of the search and listing indexes. */
const VISIBLE = "status in ('published', 'corrected')";

export interface ReaderNewsroom {
  id: string;
  slug: string;
  subdomain: string;
  name: Partial<Record<Language, string>>;
  languages: Language[];
  timezone: string;
  editorInChief: string;
  correctionsOwner: string;
}

export interface Listed {
  id: string;
  title: string | null;
  path: string;
  publishedAt: Date;
}

export interface Correction {
  id: string;
  notice: string;
  publishedAt: Date;
}

export interface ReaderPublication extends Listed {
  language: Language;
  status: "published" | "corrected";
  edited: boolean;
  series: string;
  seriesName: Partial<Record<Language, string>>;
  format: string;
  /** IPTC genre qcode of the format; plus genre:Opinion when an item relies on an opinion. */
  genres: string[];
  ninjsType: string;
  /** IPTC Media Topic qcodes of the story's beat. */
  mediaTopics: string[];
  rendition: Record<string, unknown>;
  leads: Record<string, { url: string; headline: string | null }>;
  /** The licensed images the piece shows, at site-relative URLs (D119). */
  media: Record<string, MediaContext>;
  corrections: Correction[];
}

export async function newsroomBySubdomain(
  pool: Pool,
  subdomain: string,
): Promise<ReaderNewsroom | null> {
  const { rows } = await pool.query<{
    id: string;
    slug: string;
    subdomain: string;
    name: Partial<Record<Language, string>>;
    languages: Language[];
    timezone: string;
    editor_in_chief: string;
    corrections_owner: string;
  }>(
    `select id, slug, subdomain, name, languages, timezone, editor_in_chief, corrections_owner
     from newsrooms where subdomain = $1 and removed_at is null`,
    [subdomain],
  );
  const n = rows[0];
  if (!n) return null;
  return {
    id: n.id,
    slug: n.slug,
    subdomain: n.subdomain,
    name: n.name,
    languages: n.languages,
    timezone: n.timezone,
    editorInChief: n.editor_in_chief,
    correctionsOwner: n.corrections_owner,
  };
}

const listed = (r: { id: string; title: string | null; path: string; published_at: Date }) => ({
  id: r.id,
  title: r.title,
  path: r.path,
  publishedAt: r.published_at,
});

/** A language's newest publications. */
export function latest(pool: Pool, newsroomId: string, language: Language, limit = 30) {
  return withNewsroom(pool, newsroomId, async (c) => {
    const { rows } = await c.query(
      `select id, title, path, published_at from publications
       where ${VISIBLE} and language = $1
       order by published_at desc limit $2`,
      [language, limit],
    );
    return rows.map(listed) as Listed[];
  });
}

/** Site search: trigram word similarity over normalised text (the search index's expression). */
export function search(pool: Pool, newsroomId: string, language: Language, query: string) {
  const q = query.trim().slice(0, 200);
  if (q.length < 2) return Promise.resolve([] as Listed[]);
  return withNewsroom(pool, newsroomId, async (c) => {
    const { rows } = await c.query(
      `select id, title, path, published_at,
              word_similarity(anr.normalize_text($1, $2), anr.normalize_text(search_text, language)) as score
       from publications
       where ${VISIBLE} and language = $2
         and anr.normalize_text($1, $2) <% anr.normalize_text(search_text, language)
       order by score desc, published_at desc limit 20`,
      [q, language],
    );
    return rows.map(listed) as Listed[];
  });
}

/** One publication by its path, with everything its page, JSON-LD and ninjs twin need. */
export function publicationByPath(
  pool: Pool,
  newsroomId: string,
  language: Language,
  path: string,
): Promise<ReaderPublication | null> {
  return withNewsroom(pool, newsroomId, async (c) => {
    const { rows } = await c.query<{
      id: string;
      title: string | null;
      path: string;
      published_at: Date;
      status: "published" | "corrected";
      edited: boolean;
      series: string;
      series_name: Partial<Record<Language, string>> | null;
      format: string;
      genre: string;
      ninjs_type: string;
      story_id: string | null;
      media_topics: string[] | null;
      body: Record<string, unknown> | null;
    }>(
      `select p.id, p.title, p.path, p.published_at, p.status, p.edited,
              s.slug as series, s.config->'name' as series_name,
              f.slug as format, f.genre, f.ninjs_type,
              r.story_id, b.media_topics, r.body
       from publications p
       join series s on s.id = p.series_id
       join formats f on f.id = s.format_id
       left join publication_renditions pr on pr.publication_id = p.id and pr.position = 1
       left join renditions r on r.id = pr.rendition_id
       left join stories st on st.id = r.story_id
       left join beats b on b.id = st.beat_id
       where p.${VISIBLE} and p.language = $1 and p.path = $2`,
      [language, path],
    );
    const p = rows[0];
    if (!p?.body) return null;
    const items = ((p.body.items as { claim_ids?: unknown; lead_id?: unknown }[]) ?? []).filter(
      (i) => i && typeof i === "object",
    );
    const { rows: claims } = await c.query<{ ref: string; kind: string }>(
      "select ref, kind from claims where story_id = $1 and ref is not null",
      [p.story_id],
    );
    const opinion = new Set(claims.filter((x) => x.kind === "opinion").map((x) => x.ref));
    const usesOpinion = items.some(
      (i) => Array.isArray(i.claim_ids) && i.claim_ids.some((id) => opinion.has(String(id))),
    );
    const leadIds = items.map((i) => i.lead_id).filter((x): x is string => typeof x === "string");
    const { rows: leads } = await c.query<{ id: string; uri: string; headline: string | null }>(
      "select id, uri, headline from leads where id = any($1::uuid[])",
      [leadIds],
    );
    const { rows: corrections } = await c.query<{
      id: string;
      notice: string;
      published_at: Date;
    }>(
      `select id, notice, published_at from corrections
       where publication_id = $1 and published_at is not null order by published_at`,
      [p.id],
    );
    return {
      ...listed(p),
      language,
      status: p.status,
      edited: p.edited,
      series: p.series,
      seriesName: p.series_name ?? {},
      format: p.format,
      genres: usesOpinion ? [p.genre, "genre:Opinion"] : [p.genre],
      ninjsType: p.ninjs_type,
      mediaTopics: p.media_topics ?? [],
      rendition: p.body,
      leads: Object.fromEntries(leads.map((l) => [l.id, { url: l.uri, headline: l.headline }])),
      media: await mediaContext(c, p.body, ""),
      corrections: corrections.map((x) => ({
        id: x.id,
        notice: x.notice,
        publishedAt: x.published_at,
      })),
    };
  });
}

/** The newsroom's published corrections, newest first, for its corrections page. */
export function corrections(pool: Pool, newsroomId: string, language: Language) {
  return withNewsroom(pool, newsroomId, async (c) => {
    const { rows } = await c.query<{
      id: string;
      notice: string;
      published_at: Date;
      title: string | null;
      path: string;
    }>(
      `select k.id, k.notice, k.published_at, p.title, p.path
       from corrections k join publications p on p.id = k.publication_id
       where k.published_at is not null and p.${VISIBLE} and p.language = $1
       order by k.published_at desc limit 100`,
      [language],
    );
    return rows;
  });
}

/** Robots and link previews are not readers. */
const NOT_A_READER = /bot|crawl|spider|slurp|preview|fetch|monitor|curl|wget|python|headless/i;

/**
 * Counts one page view: no cookie and nothing about the reader is stored, only a count per
 * publication and day in the newsroom's timezone (docs/technical-design.md#measures).
 */
export async function countView(
  pool: Pool,
  newsroom: Pick<ReaderNewsroom, "id" | "timezone">,
  publicationId: string,
  userAgent: string | null,
): Promise<boolean> {
  if (!userAgent || NOT_A_READER.test(userAgent)) return false;
  await withNewsroom(pool, newsroom.id, (c) =>
    c.query(
      `insert into page_views (newsroom_id, publication_id, day, count)
       values (anr.current_newsroom_id(), $1, (now() at time zone $2)::date, 1)
       on conflict (publication_id, day) do update set count = page_views.count + 1`,
      [publicationId, newsroom.timezone],
    ),
  );
  return true;
}
