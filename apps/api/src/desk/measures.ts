// The charter's measures, week by week in the newsroom's timezone (docs/technical-design.md#measures).
// Each one's definition is D99.
import type { Client } from "@anr/db";

/** A person's decision counts the time back to their first open within this window. */
export const DECISION_WINDOW_MINUTES = 60;

const IN_WEEK = (col: string) => `${col} >= w.starts and ${col} < w.ends`;

/** Checks about a publication, its renditions or their stories' claims (as the review queue). */
const HELD = `exists (
  select 1 from checks k
  where k.result <> 'pass' and k.name <> 'pulled-back'
    and (k.publication_id = p.id
      or k.rendition_id in (select rendition_id from publication_renditions where publication_id = p.id)
      or k.claim_id in (
        select c.id from claims c join renditions r on r.story_id = c.story_id
        join publication_renditions pr on pr.rendition_id = r.id where pr.publication_id = p.id)))`;

/**
 * A person's decisions on held publications: each approval, and each return once (it is recorded on
 * the assignment with the publication decided on, as well as on every language's publication).
 */
const DECISIONS = `(
  select actor_user_id, at, entity_id as publication from audit_log
  where entity = 'publications' and actor_kind = 'person' and action = 'approve'
  union all
  select actor_user_id, at, (after->>'publication')::uuid from audit_log
  where entity = 'assignments' and actor_kind = 'person' and action = 'return'
    and after ? 'publication')`;

const BY_LANGUAGE = (table: string) => `(
  select coalesce(jsonb_object_agg(language, n), '{}') from (
    select p.language, sum(v.count)::int as n from ${table} v
    join publications p on p.id = v.publication_id
    where v.day >= w.week and v.day < w.week + 7 group by p.language) t)`;

export async function measures(client: Client, weeks: number) {
  const { rows } = await client.query<{
    week: string;
    published: number;
    gated: number;
    held: number;
    corrections: number;
    cost_usd: string;
    editor_minutes: string;
    samples_reviewed: number;
    sample_misses: number;
    page_views: Record<string, number>;
    downloads: Record<string, number>;
  }>(
    `with n as (select timezone as tz from newsrooms where id = anr.current_newsroom_id()),
     w as (
       select d::date as week, d at time zone n.tz as starts, (d + interval '7 days') at time zone n.tz as ends
       from n, generate_series(date_trunc('week', now() at time zone n.tz) - make_interval(weeks => $1 - 1),
                               date_trunc('week', now() at time zone n.tz), interval '7 days') d)
     select w.week::text as week,
       (select count(*)::int from publications p where ${IN_WEEK("p.published_at")}) as published,
       g.gated, g.held,
       (select count(*)::int from sample_reviews s
        where s.outcome is not null and ${IN_WEEK("s.sampled_at")}) as samples_reviewed,
       (select count(*)::int from sample_reviews s
        where s.outcome = 'miss' and ${IN_WEEK("s.sampled_at")}) as sample_misses,
       (select count(*)::int from corrections c where ${IN_WEEK("c.created_at")}) as corrections,
       (select coalesce(sum(r.cost_usd), 0) from agent_runs r where ${IN_WEEK("r.started_at")}) as cost_usd,
       (select coalesce(sum(extract(epoch from d.at - o.first) / 60), 0)
        from ${DECISIONS} d
        cross join lateral (
          select min(o.at) as first from audit_log o
          where o.entity = 'publications' and o.entity_id = d.publication and o.action = 'open'
            and o.actor_user_id = d.actor_user_id
            and o.at <= d.at and o.at > d.at - make_interval(mins => $2)) o
        where ${IN_WEEK("d.at")}) as editor_minutes,
       ${BY_LANGUAGE("page_views")} as page_views,
       ${BY_LANGUAGE("downloads")} as downloads
     from w
     cross join lateral (
       select count(*)::int as gated, count(*) filter (where ${HELD})::int as held
       from publications p
       where ${IN_WEEK("p.slot")} and p.status not in ('assigned', 'drafted')) g
     order by w.week desc`,
    [weeks, DECISION_WINDOW_MINUTES],
  );
  const { rows: subscribers } = await client.query(
    `select distinct on (c.id) c.id as channel, c.language, c.external_id, s.subscribers,
            s.day::text as day
     from channels c join channel_stats s on s.channel_id = c.id
     where c.status = 'active' order by c.id, s.day desc`,
  );
  const ratio = (a: number, b: number, scale = 1) => (b > 0 ? (a / b) * scale : null);
  return {
    weeks: rows.map((r) => {
      const cost = Number(r.cost_usd);
      return {
        ...r,
        hold_rate: ratio(r.held, r.gated),
        corrections_per_100: ratio(r.corrections, r.published, 100),
        editor_minutes: Math.round(Number(r.editor_minutes) * 10) / 10,
        cost_usd: cost,
        cost_per_publication: ratio(cost, r.published),
      };
    }),
    subscribers,
  };
}
