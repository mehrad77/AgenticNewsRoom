// An assignment an editor returned to the desk (D96): a new desk run on the same leads. The desk's
// submit then replaces the returned publications' links (D87). The API queues this job; only the
// agents worker picks models.
import type { RedraftJob } from "@anr/core";
import { type Pool, withNewsroom } from "@anr/db";
import type { PgBoss } from "pg-boss";
import type { ModelRouter } from "./router.ts";
import { createRun } from "./runs.ts";

export type RedraftOutcome =
  | { kind: "started"; runId: string }
  | { kind: "skipped"; reason: "nothing-assigned" | "run-open" };

export function redraft(
  pool: Pool,
  boss: Pick<PgBoss, "send">,
  router: ModelRouter,
  job: RedraftJob,
): Promise<RedraftOutcome> {
  return withNewsroom(pool, job.newsroomId, async (client) => {
    // Locked, so two jobs for one assignment cannot both start a run.
    const { rows } = await client.query<{ format: string; assigned: number }>(
      `select f.slug as format,
              (select count(*)::int from publications p
               where p.assignment_id = a.id and p.status = 'assigned') as assigned
       from assignments a join series s on s.id = a.series_id join formats f on f.id = s.format_id
       where a.id = $1 for update of a`,
      [job.assignmentId],
    );
    const a = rows[0];
    if (!a || a.assigned === 0) return { kind: "skipped", reason: "nothing-assigned" };
    const { rows: open } = await client.query(
      `select 1 from agent_runs where assignment_id = $1 and role = 'desk' and outcome is null`,
      [job.assignmentId],
    );
    if (open.length > 0) return { kind: "skipped", reason: "run-open" };
    const [first] = router.resolve("desk", { format: a.format });
    if (!first) throw new Error("the desk chain is empty");
    const runId = await createRun(client, boss, {
      role: "desk",
      ...router.describe(first),
      promptVersion: "desk",
      input: `${job.assignmentId}:redraft:${new Date().toISOString()}`,
      assignmentId: job.assignmentId,
    });
    return { kind: "started", runId };
  });
}
