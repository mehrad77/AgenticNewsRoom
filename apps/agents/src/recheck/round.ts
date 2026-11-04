// One round of a recheck run started at the desk (D184): a few stories' sources and claims, then
// the gate on those ready, recorded on the run. The round queues the next until nothing is left,
// a person asks it to stop, or what it needs is down. A round that cannot reach its local models
// or ingestion ends the run as blocked before it spends any item's try.
import type { RecheckJob } from "@anr/core";
import { withNewsroom } from "@anr/db";
import { checkPass, type RecheckDeps, sourcePass, waitingSummaries } from "./run.ts";

/** Stories a round takes in each pass: a round must end well inside its job's timeout. */
export const ROUND_STORIES = 3;
/** A recheck desk run still open this long was cut off by a restart; it counts as a failed try. */
export const INTERRUPTED_AFTER_MINUTES = 30;
/** How long to wait before looking again when only the summariser has work left. */
export const WAIT_SECONDS = 60;

export interface RoundDeps extends RecheckDeps {
  /** The local models of the chains the recheck uses that are not loaded (preflight.ts). */
  notLoaded: () => Promise<string[]>;
  /** Whether ingestion answers at all. */
  ingestionUp: () => Promise<boolean>;
  /** Queues the run's next round. */
  next: (job: RecheckJob, startAfterSeconds: number) => Promise<void>;
}

type Outcome = "done" | "stopped" | "blocked" | "failed";

export async function recheckRound(deps: RoundDeps, job: RecheckJob): Promise<string> {
  const inNewsroom = <T>(fn: Parameters<typeof withNewsroom<T>>[2]) =>
    withNewsroom(deps.pool, job.newsroomId, fn);
  const finish = async (outcome: Outcome, detail: string | null = null) => {
    await inNewsroom((c) =>
      c.query(
        `update recheck_runs set finished_at = now(), outcome = $2, detail = $3, heartbeat_at = now()
         where id = $1 and finished_at is null`,
        [job.recheckRunId, outcome, detail],
      ),
    );
    return detail ? `${outcome}: ${detail}` : outcome;
  };
  // Asked between items, so it also tells the desk the run is alive.
  const shouldStop = async () =>
    inNewsroom(async (c) => {
      const { rows } = await c.query<{ stop: boolean }>(
        `update recheck_runs set heartbeat_at = now() where id = $1 and finished_at is null
         returning stop_requested_at is not null as stop`,
        [job.recheckRunId],
      );
      return rows[0]?.stop ?? true;
    });

  const open = await inNewsroom(async (c) => {
    const { rows } = await c.query(
      "select from recheck_runs where id = $1 and finished_at is null",
      [job.recheckRunId],
    );
    return rows.length > 0;
  });
  if (!open) return "finished already";
  if (await shouldStop()) return finish("stopped");

  const missing = await deps.notLoaded();
  if (missing.length > 0)
    return finish("blocked", `load these models first: ${missing.join(", ")}`);
  if (!(await deps.ingestionUp())) return finish("blocked", "ingestion does not answer");

  // Runs a restart cut off: finished as failed tries, so their items are tried again.
  await inNewsroom((c) =>
    c.query(
      `update agent_runs set outcome = 'error', finished_at = now(),
              detail = '{"error": "interrupted"}'::jsonb
       where role = 'desk' and task->>'key' = 'recheck' and outcome is null
         and started_at < now() - make_interval(mins => $1)`,
      [INTERRUPTED_AFTER_MINUTES],
    ),
  );

  const options = { newsroomId: job.newsroomId, limit: ROUND_STORIES };
  const withStop = { ...deps, shouldStop };
  let sourced: number;
  let checked: number;
  try {
    sourced = await sourcePass(withStop, options);
    checked = await checkPass(withStop, options);
  } catch (error) {
    return finish("failed", (error as Error).message);
  }
  await inNewsroom((c) =>
    c.query(
      `update recheck_runs set rounds = rounds + 1, sourced = sourced + $2, checked = checked + $3,
              heartbeat_at = now()
       where id = $1`,
      [job.recheckRunId, sourced, checked],
    ),
  );
  if (await shouldStop()) return finish("stopped");
  if (sourced > 0 || checked > 0) {
    await deps.next(job, 1);
    return `round: sourced ${sourced}, checked ${checked}`;
  }
  // Nothing to do but the summaries the check pass waits for: look again shortly.
  if ((await waitingSummaries(deps.pool, job.newsroomId)).length > 0) {
    await deps.next(job, WAIT_SECONDS);
    return "waiting for summaries";
  }
  return finish("done");
}
