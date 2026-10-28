// The planning tick (D103): once a day per newsroom, code starts the planner runs that are due.
// Themes for the cycle within THEME_LEAD_DAYS of its start, or for the current one if it still has
// none; three candidates for each weekly series whose pick window is open and whose slot falls in
// an approved cycle. Each is started once (the run's task key); nothing here calls a model.
import {
  AGENT_RUN_TIMEOUT_SECONDS,
  cycleContaining,
  cycleToPlan,
  localDay,
  type PickConfig,
  type PlanJob,
  pickWindow,
} from "@anr/core";
import { type Client, type Pool, withNewsroom } from "@anr/db";
import type { PgBoss } from "pg-boss";
import type { ModelRouter } from "../router.ts";
import { createRun } from "../runs.ts";
import { newsroomFacts } from "./context.ts";
import type { PlannerTask } from "./run.ts";

export type TickOutcome =
  | { kind: "themes" | "candidates"; key: string; runId: string }
  | { kind: "no-theme"; starts: string };

/**
 * A planner run still open this long after it started will not finish: its job used up its
 * retries, expired, or waits for a model key. pg-boss retries twice (three attempts).
 */
export const STALE_RUN_SECONDS = 3 * AGENT_RUN_TIMEOUT_SECONDS;

/** Closes stale planner runs as timed out, so their task can start again, and says so once. */
async function closeStale(client: Client): Promise<void> {
  const { rows } = await client.query<{ task: { key: string } }>(
    // The database's clock, which set started_at; `now` may be a planning day, not the time.
    `update agent_runs set outcome = 'timed-out', finished_at = now(),
       detail = '{"reason": "the run never finished"}'
     where role = 'planner' and outcome is null
       and started_at < now() - make_interval(secs => $1)
     returning task`,
    [STALE_RUN_SECONDS],
  );
  for (const r of rows) {
    await client.query(
      `insert into notices (newsroom_id, kind, key, detail)
       values (anr.current_newsroom_id(), 'plan-failed', $1, $2)
       on conflict (newsroom_id, kind, key) do update set detail = excluded.detail, read_at = null`,
      [r.task.key, JSON.stringify({ task: r.task, reason: "the planner run never finished" })],
    );
  }
}

/** Whether planner work under this key is running or was submitted; a failed run may be redone. */
async function started(client: Client, key: string): Promise<boolean> {
  const { rowCount } = await client.query(
    `select from agent_runs where role = 'planner' and task->>'key' = $1
       and (outcome is null or outcome = 'submitted')`,
    [key],
  );
  return (rowCount ?? 0) > 0;
}

export async function planTick(
  pool: Pool,
  boss: Pick<PgBoss, "send">,
  router: ModelRouter,
  job: PlanJob,
  now: Date = new Date(),
): Promise<TickOutcome[]> {
  return withNewsroom(pool, job.newsroomId, async (client) => {
    // One tick at a time per newsroom: a catch-up firing beside the daily one starts nothing twice.
    await client.query("select pg_advisory_xact_lock(hashtext('plan:' || $1))", [job.newsroomId]);
    await closeStale(client);
    const n = await newsroomFacts(client);
    const today = localDay(now, n.timezone);
    const out: TickOutcome[] = [];
    const [first] = router.resolve("planner");
    if (!first) throw new Error("the planner chain is empty");
    const start = async (task: PlannerTask) => {
      const runId = await createRun(client, boss, {
        role: "planner",
        ...router.describe(first),
        // Set to the assembled prompt's version when the run starts.
        promptVersion: "planner",
        input: task.key,
        task,
      });
      out.push({ kind: task.kind, key: task.key, runId });
    };

    const span = cycleToPlan(n.planning, today);
    if (span) {
      const key = `themes:${span.starts}`;
      const { rowCount } = await client.query("select from editorial_cycles where starts = $1", [
        span.starts,
      ]);
      if (!rowCount && !(await started(client, key)))
        await start({ key, kind: "themes", starts: span.starts, ends: span.ends });
    }

    // A cycle under way with nothing approved: its picks wait, and the Editor-in-Chief is told once.
    const current = cycleContaining(n.planning, today);
    if (current) {
      const { rowCount } = await client.query(
        "select from editorial_cycles where starts = $1 and status = 'approved'",
        [current.starts],
      );
      if (!rowCount) {
        await client.query(
          `insert into notices (newsroom_id, kind, key, detail)
           values (anr.current_newsroom_id(), 'no-theme', $1, $2)
           on conflict (newsroom_id, kind, key) do nothing`,
          [current.starts, JSON.stringify(current)],
        );
        out.push({ kind: "no-theme", starts: current.starts });
      }
    }

    const { rows: series } = await client.query<{
      id: string;
      slug: string;
      pick: PickConfig;
      weekly: string;
    }>(
      `select id, slug, config->'pick' as pick, config->'cadence'->>'weekly' as weekly
       from series where removed_at is null and config ? 'pick' and config->'cadence' ? 'weekly'
       order by slug`,
    );
    for (const s of series) {
      const w = pickWindow(s.pick, s.weekly, today, n.timezone);
      if (!w || now >= w.deadline) continue;
      const key = `candidates:${s.slug}:${w.week}`;
      const { rowCount } = await client.query(
        "select from picks where series_id = $1 and week = $2",
        [s.id, w.week],
      );
      if (rowCount || (await started(client, key))) continue;
      const slotDay = localDay(w.slot, n.timezone);
      const { rows: cycle } = await client.query<{ id: string }>(
        `select id from editorial_cycles
         where status = 'approved' and starts <= $1::date and ends > $1::date`,
        [slotDay],
      );
      const cycleId = cycle[0]?.id;
      if (!cycleId) {
        // The slot's cycle has no approved theme: this week gets no candidates, and is not missed
        // silently.
        await client.query(
          `insert into notices (newsroom_id, kind, key, detail)
           values (anr.current_newsroom_id(), 'no-theme', $1, $2)
           on conflict (newsroom_id, kind, key) do nothing`,
          [key, JSON.stringify({ series: s.slug, week: w.week, slot: w.slot.toISOString() })],
        );
        continue;
      }
      await start({
        key,
        kind: "candidates",
        series_id: s.id,
        cycle_id: cycleId,
        week: w.week,
        slot: w.slot.toISOString(),
        deadline: w.deadline.toISOString(),
      });
    }
    return out;
  });
}
