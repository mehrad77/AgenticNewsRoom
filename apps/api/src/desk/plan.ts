// The Editor-in-Chief's planning decisions (D105): approve one proposed theme, edited, for its
// cycle; choose one of a weekly pick's candidates before its deadline. Each is an audited update in
// the transaction that makes it, and a choice queues its assignment there too (invariant 10).
import { type AssignJob, QUEUES } from "@anr/core";
import { auditedUpdate, type Client, onClient } from "@anr/db";
import type { PgBoss } from "pg-boss";
import { DeskError } from "./errors.ts";

type Actor = { kind: "person"; userId: string };

interface Week {
  week: string;
  focus: string;
}
interface PlanLead {
  id: string;
  url: string;
  headline: string | null;
}

async function leadsById(client: Client, ids: readonly string[]): Promise<Map<string, PlanLead>> {
  const { rows } = await client.query<PlanLead>(
    "select id, uri as url, headline from leads where id = any($1::uuid[])",
    [[...new Set(ids)]],
  );
  return new Map(rows.map((l) => [l.id, l]));
}

/** Themes of the current and later cycles, and picks of the last four weeks and later. */
export async function plan(client: Client) {
  const { rows: themes } = await client.query<{
    id: string;
    starts: string;
    ends: string;
    theme: string;
    angle: string | null;
    rationale: string | null;
    calendar: Week[] | null;
    status: "proposed" | "approved" | "declined";
    decided_at: Date | null;
    lead_ids: string[];
  }>(
    `select c.id, c.starts::text, c.ends::text, c.theme, c.angle, c.rationale, c.calendar, c.status,
            c.decided_at, c.lead_ids
     from editorial_cycles c join newsrooms n on n.id = c.newsroom_id
     where c.ends > (now() at time zone n.timezone)::date
     order by c.starts desc, c.status = 'approved' desc, c.created_at`,
  );
  const { rows: picks } = await client.query<{
    id: string;
    series: string;
    week: string;
    slot: Date;
    deadline: Date;
    chosen: number | null;
    picked_at: Date | null;
    skipped_at: Date | null;
    candidates: { title: string; angle: string; why: string; lead_ids: string[] }[];
  }>(
    `select p.id, s.slug as series, p.week::text, p.slot, p.deadline, p.chosen, p.picked_at,
            p.skipped_at, p.candidates
     from picks p join series s on s.id = p.series_id join newsrooms n on n.id = p.newsroom_id
     where p.week >= (now() at time zone n.timezone)::date - 28
     order by p.week desc, s.slug`,
  );
  const leads = await leadsById(client, [
    ...themes.flatMap((t) => t.lead_ids),
    ...picks.flatMap((p) => p.candidates.flatMap((c) => c.lead_ids)),
  ]);
  const resolve = (ids: readonly string[]) =>
    ids.map((id) => leads.get(id)).filter((l): l is PlanLead => l !== undefined);
  return {
    themes: themes.map(({ lead_ids, calendar, ...t }) => ({
      ...t,
      calendar: calendar ?? [],
      leads: resolve(lead_ids),
    })),
    picks: picks.map(({ candidates, ...p }) => ({
      ...p,
      candidates: candidates.map(({ lead_ids, ...c }) => ({ ...c, leads: resolve(lead_ids) })),
    })),
  };
}

export interface ThemeEdit {
  theme: string;
  angle: string;
  calendar: Week[];
}

/**
 * Approves one proposal as the Editor-in-Chief edited it: the same weeks, each with its focus.
 * The cycle's other proposals are declined; a cycle has at most one approved theme.
 */
export async function approveTheme(client: Client, actor: Actor, id: string, edit: ThemeEdit) {
  // Every proposal of the cycle is locked in one ordered statement, so two approvals at once
  // queue behind each other instead of deadlocking, and only one can pass the checks below.
  const { rows } = await client.query<{
    id: string;
    starts: string;
    status: string;
    theme: string;
    angle: string | null;
    calendar: Week[] | null;
  }>(
    `select id, starts::text, status, theme, angle, calendar from editorial_cycles
     where starts = (select starts from editorial_cycles where id = $1)
     order by id for update`,
    [id],
  );
  const proposal = rows.find((r) => r.id === id);
  if (!proposal) throw new DeskError(404, "no such theme");
  if (proposal.status !== "proposed")
    throw new DeskError(409, `this theme is already ${proposal.status}`);
  const siblings = rows.filter((r) => r.id !== id);
  if (siblings.some((s) => s.status === "approved"))
    throw new DeskError(409, "another theme is already approved for this cycle");
  const weeks = (proposal.calendar ?? []).map((w) => w.week);
  if (
    edit.calendar.length !== weeks.length ||
    edit.calendar.some((w, i) => w.week !== weeks[i] || !w.focus.trim())
  ) {
    throw new DeskError(400, `calendar: give a focus for each week, ${weeks.join(", ")}`);
  }
  const now = new Date();
  const changes: Record<string, unknown> = {
    status: "approved",
    decided_by: actor.userId,
    decided_at: now,
  };
  if (edit.theme !== proposal.theme) changes.theme = edit.theme;
  if (edit.angle !== proposal.angle) changes.angle = edit.angle;
  const calendar = edit.calendar.map((w) => ({ week: w.week, focus: w.focus.trim() }));
  if (JSON.stringify(calendar) !== JSON.stringify(proposal.calendar))
    changes.calendar = JSON.stringify(calendar);
  await auditedUpdate(client, actor, "approve", "editorial_cycles", id, changes);
  for (const s of siblings.filter((x) => x.status === "proposed")) {
    await auditedUpdate(client, actor, "decline", "editorial_cycles", s.id, {
      status: "declined",
      decided_by: actor.userId,
      decided_at: now,
    });
  }
  return { id, status: "approved" };
}

/**
 * Chooses a candidate before the pick's deadline and queues its assignment (D104); after the
 * deadline the slot is skipped, so a late choice is refused.
 */
export async function choosePick(
  client: Client,
  boss: Pick<PgBoss, "send">,
  actor: Actor,
  id: string,
  candidate: number,
  now: Date = new Date(),
) {
  const { rows } = await client.query<{
    series_id: string;
    deadline: Date;
    picked: boolean;
    skipped: boolean;
    count: number;
  }>(
    `select series_id, deadline, picked_at is not null as picked, skipped_at is not null as skipped,
            jsonb_array_length(candidates) as count
     from picks where id = $1 for update`,
    [id],
  );
  const pick = rows[0];
  if (!pick) throw new DeskError(404, "no such pick");
  if (pick.picked) throw new DeskError(409, "this pick is already chosen");
  if (pick.skipped || now >= pick.deadline)
    throw new DeskError(409, "the pick's deadline has passed; its slot is skipped");
  if (candidate >= pick.count) throw new DeskError(400, `candidate: 0 to ${pick.count - 1}`);
  await auditedUpdate(client, actor, "choose", "picks", id, {
    chosen: candidate,
    picked_by: actor.userId,
    picked_at: now,
  });
  const { rows: n } = await client.query<{ id: string }>("select anr.current_newsroom_id() as id");
  const job: AssignJob = { newsroomId: n[0]?.id ?? "", seriesId: pick.series_id, pickId: id };
  await boss.send(QUEUES.assign, job, { db: onClient(client) });
  return { id, status: "chosen" };
}
