// The daily assignment (D81): at a daily series' assignment_at, the last 24 hours of leads ranked
// by tier become an assignment for that evening's slot, with one publication per language and a
// desk run. Code only; nothing here asks a model.
import type { AssignJob } from "@anr/core";
import { type Client, type Pool, withNewsroom } from "@anr/db";
import type { PgBoss } from "pg-boss";
import type { ModelRouter } from "./router.ts";
import { createRun } from "./runs.ts";

/** Leads per item the series allows: room to choose, bounded so the prompt stays affordable. */
export const LEADS_PER_ITEM = 2;
export const MAX_ASSIGNMENT_LEADS = 24;
export const LEAD_WINDOW_HOURS = 24;

/** Most items a series' issue may hold: the sum of each `items` range's upper bound. */
export function maxItems(items: Record<string, string> | undefined): number {
  return Object.values(items ?? {}).reduce(
    (sum, range) => sum + Number(range.split("-")[1] ?? 0),
    0,
  );
}

export type AssignOutcome =
  | { kind: "assigned"; assignmentId: string; leads: number; runId: string }
  | {
      kind: "exists" | "not-daily" | "slot-passed" | "no-leads" | "not-chosen";
      slot?: string;
    };

export interface NewAssignment {
  seriesId: string;
  slot: string;
  format: string;
  languages: readonly string[];
  leadIds: readonly string[];
  cycleId?: string | null;
  pickId?: string;
  angle?: string;
}

/**
 * One transaction's worth: the assignment, its leads, one publication per series language (a
 * publication exists from the moment its assignment is made) and the desk run with its job.
 * Null when the series already has an assignment for the slot.
 */
export async function createAssignment(
  client: Client,
  boss: Pick<PgBoss, "send">,
  router: ModelRouter,
  a: NewAssignment,
): Promise<{ assignmentId: string; runId: string } | null> {
  const { rows: created } = await client.query<{ id: string }>(
    `insert into assignments (newsroom_id, series_id, slot, cycle_id, pick_id, angle)
     values (anr.current_newsroom_id(), $1, $2, $3, $4, $5)
     on conflict (newsroom_id, series_id, slot) do nothing returning id`,
    [a.seriesId, a.slot, a.cycleId ?? null, a.pickId ?? null, a.angle ?? null],
  );
  const assignmentId = created[0]?.id;
  if (!assignmentId) return null;
  await client.query(
    `insert into assignment_leads (newsroom_id, assignment_id, lead_id)
     select anr.current_newsroom_id(), $1, unnest($2::uuid[])`,
    [assignmentId, a.leadIds],
  );
  await client.query(
    `insert into publications (newsroom_id, series_id, assignment_id, slot, language)
     select anr.current_newsroom_id(), $1, $2, $3, unnest($4::text[])`,
    [a.seriesId, assignmentId, a.slot, a.languages],
  );
  const [first] = router.resolve("desk", { format: a.format });
  if (!first) throw new Error("the desk chain is empty");
  const runId = await createRun(client, boss, {
    role: "desk",
    ...router.describe(first),
    // Set to the assembled prompt's version when the run starts.
    promptVersion: "desk",
    input: `${assignmentId}:${a.leadIds.join(",")}`,
    assignmentId,
  });
  return { assignmentId, runId };
}

/**
 * A chosen weekly pick becomes its slot's assignment (D104): the chosen candidate's angle and
 * leads, in the pick's cycle, so the gate treats it as themed work. Leads withdrawn or put in a
 * banned beat since the planner proposed them are left out.
 */
export async function assignPick(
  pool: Pool,
  boss: Pick<PgBoss, "send">,
  router: ModelRouter,
  job: AssignJob & { pickId: string },
  now: Date = new Date(),
): Promise<AssignOutcome> {
  return withNewsroom(pool, job.newsroomId, async (client) => {
    const { rows } = await client.query<{
      cycle_id: string;
      series_id: string;
      slot: Date;
      candidate: { title: string; angle: string; lead_ids: string[] } | null;
      skipped: boolean;
      slug: string;
      format: string;
      languages: string[];
    }>(
      `select p.cycle_id, p.series_id, p.slot, p.skipped_at is not null as skipped,
              case when p.chosen is null then null else p.candidates->(p.chosen::int) end as candidate,
              s.slug, f.slug as format, s.languages
       from picks p join series s on s.id = p.series_id join formats f on f.id = s.format_id
       where p.id = $1 and s.removed_at is null
       for update of p`,
      [job.pickId],
    );
    const pick = rows[0];
    if (!pick?.candidate || pick.skipped) return { kind: "not-chosen" };
    const slot = pick.slot.toISOString();
    if (pick.slot <= now) return { kind: "slot-passed", slot };
    const { rows: leads } = await client.query<{ id: string }>(
      `select l.id from leads l
       where l.id = any($1::uuid[]) and l.withdrawn_at is null
         and not exists (select from lead_beats lb join beats b on b.id = lb.beat_id
                         where lb.lead_id = l.id and b.status = 'banned')
       order by l.tier, coalesce(l.first_created, l.fetched_at) desc`,
      [pick.candidate.lead_ids],
    );
    if (leads.length === 0) {
      await client.query(
        `insert into notices (newsroom_id, kind, key, detail)
         values (anr.current_newsroom_id(), 'no-leads', $1, $2)
         on conflict (newsroom_id, kind, key) do nothing`,
        [`${pick.slug}:${slot}`, JSON.stringify({ series: pick.slug, slot, pick: job.pickId })],
      );
      return { kind: "no-leads", slot };
    }
    const made = await createAssignment(client, boss, router, {
      seriesId: pick.series_id,
      slot,
      format: pick.format,
      languages: pick.languages,
      leadIds: leads.map((l) => l.id),
      cycleId: pick.cycle_id,
      pickId: job.pickId,
      angle: `${pick.candidate.title}. ${pick.candidate.angle}`,
    });
    if (!made) return { kind: "exists", slot };
    return { kind: "assigned", ...made, leads: leads.length };
  });
}

export async function assignDaily(
  pool: Pool,
  boss: Pick<PgBoss, "send">,
  router: ModelRouter,
  job: AssignJob,
  now: Date = new Date(),
): Promise<AssignOutcome> {
  return withNewsroom(pool, job.newsroomId, async (client) => {
    const { rows } = await client.query<{
      slug: string;
      format: string;
      languages: string[];
      items: Record<string, string> | null;
      slot: Date | null;
      passed: boolean;
    }>(
      `select s.slug, f.slug as format, s.languages, s.config->'items' as items,
              (($2::timestamptz at time zone n.timezone)::date + (s.config->'cadence'->>'daily')::time)
                at time zone n.timezone as slot,
              (($2::timestamptz at time zone n.timezone)::date + (s.config->'cadence'->>'daily')::time)
                at time zone n.timezone <= $2::timestamptz as passed
       from series s join formats f on f.id = s.format_id join newsrooms n on n.id = s.newsroom_id
       where s.id = $1 and s.removed_at is null`,
      [job.seriesId, now],
    );
    const series = rows[0];
    if (!series?.slot) return { kind: "not-daily" };
    const slot = series.slot.toISOString();
    if (series.passed) return { kind: "slot-passed", slot };
    // Before choosing leads: this slot's own leads are already used, so a second firing would
    // otherwise find none and report no leads.
    const { rowCount: exists } = await client.query(
      "select from assignments where series_id = $1 and slot = $2",
      [job.seriesId, slot],
    );
    if (exists) return { kind: "exists", slot };

    const limit = Math.min(
      MAX_ASSIGNMENT_LEADS,
      Math.max(LEADS_PER_ITEM, LEADS_PER_ITEM * maxItems(series.items ?? undefined)),
    );
    const { rows: leads } = await client.query<{ id: string }>(
      `select l.id from leads l
       where l.fetched_at > $4::timestamptz - make_interval(hours => $2)
         and l.fetched_at <= $4::timestamptz
         and l.summary is not null
         and l.withdrawn_at is null
         and not exists (select from lead_beats lb join beats b on b.id = lb.beat_id
                         where lb.lead_id = l.id and b.status = 'banned')
         and not exists (select from assignment_leads al join assignments a on a.id = al.assignment_id
                         where al.lead_id = l.id and a.series_id = $1)
       order by l.tier, coalesce(l.first_created, l.fetched_at) desc
       limit $3`,
      [job.seriesId, LEAD_WINDOW_HOURS, limit, now],
    );
    if (leads.length === 0) {
      await client.query(
        `insert into notices (newsroom_id, kind, key, detail)
         values (anr.current_newsroom_id(), 'no-leads', $1, $2)
         on conflict (newsroom_id, kind, key) do nothing`,
        [`${series.slug}:${slot}`, JSON.stringify({ series: series.slug, slot })],
      );
      return { kind: "no-leads", slot };
    }

    const made = await createAssignment(client, boss, router, {
      seriesId: job.seriesId,
      slot,
      format: series.format,
      languages: series.languages,
      leadIds: leads.map((l) => l.id),
    });
    if (!made) return { kind: "exists", slot };
    const { assignmentId, runId } = made;
    return { kind: "assigned", assignmentId, leads: leads.length, runId };
  });
}
