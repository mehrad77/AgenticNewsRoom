// What the planner is shown (technical design, Agent runs): the last cycle's stats, lead pool
// trends and policy, plus, for a weekly pick, the approved theme and this week's focus. Code reads
// it; the model may search and read further with its tools.
import { addDays, type CycleSpan, cycleContaining, onOrBefore, type Planning } from "@anr/core";
import type { Client } from "@anr/db";

/** Recent credible leads shown up front; the planner searches for the rest. */
export const SHOWN_LEADS = 25;
export const RECENT_DAYS = 14;
const SUMMARY_CHARS = 240;

export interface Beat {
  slug: string;
  status: string;
  description: string | null;
}

export interface NewsroomFacts {
  slug: string;
  name: string;
  languages: string[];
  timezone: string;
  planning: Planning;
  beats: Beat[];
}

export async function newsroomFacts(client: Client): Promise<NewsroomFacts> {
  const { rows } = await client.query<NewsroomFacts>(
    `select n.slug, coalesce(n.name->>'en', n.slug) as name, n.languages, n.timezone, n.planning,
            coalesce((select json_agg(json_build_object('slug', b.slug, 'status', b.status,
                                                       'description', b.description) order by b.slug)
                      from beats b where b.removed_at is null), '[]') as beats
     from newsrooms n where n.id = anr.current_newsroom_id()`,
  );
  const row = rows[0];
  if (!row) throw new Error("no newsroom set");
  return row;
}

function beatsBlock(beats: readonly Beat[]): string {
  return beats
    .map((b) => `- ${b.slug} (${b.status})${b.description ? `: ${b.description}` : ""}`)
    .join("\n");
}

/** Published pieces, readers and listeners per series over a cycle, and its approved theme. */
async function cycleStats(client: Client, span: CycleSpan, timezone: string): Promise<string> {
  const { rows } = await client.query<{
    series: string;
    published: number;
    views: number;
    downloads: number;
  }>(
    `select s.slug as series, count(p.id)::int as published,
            coalesce(sum((select sum(v.count) from page_views v where v.publication_id = p.id)), 0)::int as views,
            coalesce(sum((select sum(d.count) from downloads d where d.publication_id = p.id)), 0)::int as downloads
     from series s
     left join publications p on p.series_id = s.id and p.status in ('published', 'corrected')
       and (p.slot at time zone $3)::date >= $1::date and (p.slot at time zone $3)::date < $2::date
     where s.removed_at is null group by s.slug order by s.slug`,
    [span.starts, span.ends, timezone],
  );
  const { rows: theme } = await client.query<{ theme: string; angle: string | null }>(
    "select theme, angle from editorial_cycles where starts = $1 and status = 'approved'",
    [span.starts],
  );
  const lines = rows.map(
    (r) =>
      `- ${r.series}: ${r.published} published, ${r.views} page views, ${r.downloads} downloads`,
  );
  const approved = theme[0];
  return [
    `Last cycle (${span.starts} to ${addDays(span.ends, -1)}): ${
      approved ? `theme "${approved.theme}"` : "no approved theme"
    }`,
    ...lines,
  ].join("\n");
}

/** Leads per beat over the last 30 days against the 30 before: what the pool is growing in. */
async function trends(client: Client, now: Date): Promise<string> {
  const { rows } = await client.query<{ beat: string; recent: number; before: number }>(
    `select b.slug as beat,
            count(*) filter (where l.fetched_at > $1::timestamptz - interval '30 days')::int as recent,
            count(*) filter (where l.fetched_at <= $1::timestamptz - interval '30 days')::int as before
     from beats b join lead_beats lb on lb.beat_id = b.id join leads l on l.id = lb.lead_id
     where b.removed_at is null and b.status <> 'banned' and l.withdrawn_at is null
       and l.fetched_at > $1::timestamptz - interval '60 days' and l.fetched_at <= $1::timestamptz
     group by b.slug order by b.slug`,
    [now],
  );
  if (rows.length === 0) return "Lead pool: no classified leads in the last 60 days.";
  return [
    "Leads per beat, last 30 days (and the 30 before):",
    ...rows.map((r) => `- ${r.beat}: ${r.recent} (${r.before})`),
  ].join("\n");
}

/** The freshest credible leads, summarised and in no banned beat, best tier first. */
async function recentLeads(client: Client, now: Date): Promise<string> {
  const { rows } = await client.query<{
    id: string;
    headline: string | null;
    publisher: string | null;
    tier: number;
    beats: string[];
    summary: string;
  }>(
    `select l.id, l.headline, so.publisher, l.tier, l.summary,
            array(select b.slug from lead_beats lb join beats b on b.id = lb.beat_id
                  where lb.lead_id = l.id order by b.slug) as beats
     from leads l left join sources so on so.id = l.source_id
     where l.summary is not null and l.withdrawn_at is null
       and l.fetched_at > $1::timestamptz - make_interval(days => $2)
       and not exists (select from lead_beats lb join beats b on b.id = lb.beat_id
                       where lb.lead_id = l.id and b.status = 'banned')
     order by l.tier, coalesce(l.first_created, l.fetched_at) desc
     limit $3`,
    [now, RECENT_DAYS, SHOWN_LEADS],
  );
  if (rows.length === 0) return "Recent leads: none; use search_leads.";
  return [
    `Recent leads (last ${RECENT_DAYS} days, best tier first):`,
    ...rows.map(
      (l) =>
        `- ${l.id} | tier ${l.tier} | ${l.publisher ?? "?"} | ${l.beats.join(", ") || "-"} | ${
          l.headline ?? "(no headline)"
        }: ${l.summary.slice(0, SUMMARY_CHARS)}`,
    ),
  ].join("\n");
}

export async function themesMessage(
  client: Client,
  n: NewsroomFacts,
  span: CycleSpan,
  weeks: readonly string[],
  now: Date,
): Promise<string> {
  const last = cycleContaining(n.planning, addDays(span.starts, -1));
  return [
    `Newsroom: ${n.name} (${n.slug}), languages ${n.languages.join(", ")}.`,
    `Cycle to plan: ${span.starts} to ${addDays(span.ends, -1)}. Calendar weeks (Mondays): ${weeks.join(", ")}.`,
    `Beats:\n${beatsBlock(n.beats)}`,
    last ? await cycleStats(client, last, n.timezone) : "Last cycle: none, this is the first.",
    await trends(client, now),
    await recentLeads(client, now),
  ].join("\n\n");
}

export interface PickFacts {
  series: string;
  seriesName: string;
  format: string;
  slot: Date;
  theme: string;
  angle: string | null;
  focus: string | null;
  earlier: string[];
}

export async function pickFacts(
  client: Client,
  seriesId: string,
  cycleId: string,
  slot: Date,
  timezone: string,
): Promise<PickFacts> {
  const { rows } = await client.query<Omit<PickFacts, "slot" | "focus"> & { calendar: unknown }>(
    `select s.slug as series, coalesce(s.config->'name'->>'en', s.slug) as "seriesName", f.slug as format,
            c.theme, c.angle, c.calendar,
            array(select p.candidates->(p.chosen::int)->>'title' from picks p
                  where p.series_id = s.id and p.chosen is not null order by p.week desc limit 12) as earlier
     from series s join formats f on f.id = s.format_id, editorial_cycles c
     where s.id = $1 and c.id = $2`,
    [seriesId, cycleId],
  );
  const row = rows[0];
  if (!row) throw new Error("pick series or cycle missing");
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(slot);
  const week = onOrBefore(day, "mon");
  const calendar = Array.isArray(row.calendar)
    ? (row.calendar as { week: string; focus: string }[])
    : [];
  const focus = calendar.find((c) => c.week === week)?.focus ?? null;
  return { ...row, slot, focus };
}

export async function candidatesMessage(
  client: Client,
  n: NewsroomFacts,
  p: PickFacts,
  now: Date,
): Promise<string> {
  return [
    `Newsroom: ${n.name} (${n.slug}). Series: ${p.seriesName} (${p.series}), format ${p.format}, publishing ${p.slot.toISOString()}.`,
    `Cycle theme: ${p.theme}${p.angle ? `\nAngle: ${p.angle}` : ""}${p.focus ? `\nThis week's focus: ${p.focus}` : ""}`,
    `Beats:\n${beatsBlock(n.beats)}`,
    p.earlier.length > 0
      ? `Earlier picks of this series (do not repeat):\n${p.earlier.map((t) => `- ${t}`).join("\n")}`
      : "Earlier picks: none.",
    await recentLeads(client, now),
  ].join("\n\n");
}

/**
 * Why each cited lead may not back a proposal: unknown in this newsroom, withdrawn, or in a banned
 * beat. Empty when every one may.
 */
export async function leadProblems(client: Client, ids: readonly string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  const { rows } = await client.query<{ id: string; withdrawn: boolean; banned: boolean }>(
    `select l.id, l.withdrawn_at is not null as withdrawn,
            exists (select from lead_beats lb join beats b on b.id = lb.beat_id
                    where lb.lead_id = l.id and b.status = 'banned') as banned
     from leads l where l.id = any($1::uuid[])`,
    [unique],
  );
  const found = new Map(rows.map((r) => [r.id, r]));
  const problems: string[] = [];
  for (const id of unique) {
    const lead = found.get(id);
    if (!lead) problems.push(`lead ${id} is not stored in this newsroom`);
    else if (lead.withdrawn) problems.push(`lead ${id} is withdrawn`);
    else if (lead.banned) problems.push(`lead ${id} is in a banned beat`);
  }
  return problems;
}
