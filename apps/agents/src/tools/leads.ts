// Reading the lead pool for agents: one lead's frozen text, and trigram search over the
// newsroom's pool (D73). Plain functions inside withNewsroom(); tools.ts wraps them for models.
import { type Pool, withNewsroom } from "@anr/db";

/** Stored text beyond this is cut when a model reads a lead; claims quote what it was shown. */
export const MAX_LEAD_CHARS = 12_000;
export const MAX_SEARCH_RESULTS = 10;
/** pg_trgm word similarity a lead's text needs to match a query (0 to 1). */
export const SEARCH_THRESHOLD = 0.3;

export interface LeadText {
  id: string;
  uri: string;
  headline: string | null;
  language: string;
  tier: number;
  publisher: string;
  summary: string | null;
  beats: string[];
  /** ninjs firstCreated, when the source dated it. */
  published: string | null;
  /** The frozen text, cut at MAX_LEAD_CHARS. */
  text: string;
  truncated: boolean;
  /** Set when the lead was later found withdrawn or retracted (D78); never cite it. */
  withdrawn: string | null;
}

export interface LeadHit {
  id: string;
  headline: string | null;
  summary: string | null;
  tier: number;
  publisher: string;
  published: string | null;
  score: number;
}

/**
 * A lead's publisher, for source independence: the source's publisher, else the host of the
 * lead's URL without `www.` (a lead an agent requested from an unknown site has no source).
 */
const PUBLISHER = `coalesce(s.publisher, regexp_replace(substring(l.uri from '^[a-z]+://([^/:]+)'), '^www\\.', ''))`;

export async function readLead(
  pool: Pool,
  newsroomId: string,
  leadId: string,
): Promise<LeadText | null> {
  return withNewsroom(pool, newsroomId, async (client) => {
    const { rows } = await client.query<Omit<LeadText, "text" | "truncated"> & { body: string }>(
      `select l.id, l.uri, l.headline, l.language, l.tier, ${PUBLISHER} as publisher, l.summary,
              coalesce(array(select b.slug from lead_beats lb join beats b on b.id = lb.beat_id
                             where lb.lead_id = l.id order by b.slug), '{}') as beats,
              to_char(l.first_created at time zone 'UTC', 'YYYY-MM-DD') as published,
              l.body, l.withdrawn_reason as withdrawn
       from leads l left join sources s on s.id = l.source_id
       where l.id = $1`,
      [leadId],
    );
    const row = rows[0];
    if (!row) return null;
    const { body, ...lead } = row;
    const truncated = body.length > MAX_LEAD_CHARS;
    return { ...lead, text: truncated ? body.slice(0, MAX_LEAD_CHARS) : body, truncated };
  });
}

/**
 * Leads whose normalised headline, summary and text contain words like the query, best first,
 * then by tier and recency. Withdrawn leads are never found. The expression in `where` is the
 * one the trigram index is built on, so the index applies.
 */
export async function searchLeads(
  pool: Pool,
  newsroomId: string,
  query: string,
  language: string,
  limit = MAX_SEARCH_RESULTS,
): Promise<LeadHit[]> {
  const q = query.trim();
  if (q.length < 3) return [];
  return withNewsroom(pool, newsroomId, async (client) => {
    await client.query("select set_config('pg_trgm.word_similarity_threshold', $1, true)", [
      String(SEARCH_THRESHOLD),
    ]);
    const { rows } = await client.query<LeadHit>(
      `with q as (select anr.normalize_text($1, $2) as text)
       select l.id, l.headline, l.summary, l.tier, ${PUBLISHER} as publisher,
              to_char(l.first_created at time zone 'UTC', 'YYYY-MM-DD') as published,
              round(word_similarity(q.text, anr.normalize_text(
                coalesce(l.headline, '') || ' ' || coalesce(l.summary, '') || ' ' || l.body,
                l.language))::numeric, 2)::float8 as score
       from leads l cross join q left join sources s on s.id = l.source_id
       where q.text <% anr.normalize_text(
               coalesce(l.headline, '') || ' ' || coalesce(l.summary, '') || ' ' || l.body, l.language)
         and l.withdrawn_at is null
       order by score desc, l.tier, coalesce(l.first_created, l.fetched_at) desc
       limit $3`,
      [q, language, Math.min(Math.max(1, limit), MAX_SEARCH_RESULTS)],
    );
    return rows;
  });
}
