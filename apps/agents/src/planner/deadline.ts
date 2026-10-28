// A weekly pick's deadline (D104): a job queued with the candidates to run at the deadline. With
// no choice by then, the slot is skipped and the Editor-in-Chief is told; nothing is assigned. A
// pick chosen in time was assigned when it was chosen, so the job finds nothing to do.
import { type PickDeadlineJob, QUEUES } from "@anr/core";
import { auditedUpdate, type Pool, withNewsroom } from "@anr/db";
import type { PgBoss } from "pg-boss";
import { onClient } from "../runs.ts";

export type DeadlineOutcome = "skipped" | "decided" | "early" | "gone";

export async function pickDeadline(
  pool: Pool,
  boss: Pick<PgBoss, "send">,
  job: PickDeadlineJob,
  now: Date = new Date(),
): Promise<DeadlineOutcome> {
  return withNewsroom(pool, job.newsroomId, async (client) => {
    const { rows } = await client.query<{
      deadline: Date;
      decided: boolean;
      series: string;
      week: string;
      slot: Date;
    }>(
      `select p.deadline, (p.picked_at is not null or p.skipped_at is not null) as decided,
              s.slug as series, p.week::text as week, p.slot
       from picks p join series s on s.id = p.series_id where p.id = $1 for update of p`,
      [job.pickId],
    );
    const pick = rows[0];
    if (!pick) return "gone";
    if (pick.decided) return "decided";
    if (now < pick.deadline) {
      // Run early (a clock moved): come back at the deadline.
      await boss.send(QUEUES.pickDeadline, job, {
        db: onClient(client),
        startAfter: pick.deadline,
        singletonKey: `${job.pickId}:${pick.deadline.toISOString()}`,
      });
      return "early";
    }
    await auditedUpdate(client, { kind: "code", name: "planner" }, "skip", "picks", job.pickId, {
      skipped_at: now,
    });
    await client.query(
      `insert into notices (newsroom_id, kind, key, detail)
       values (anr.current_newsroom_id(), 'pick-missed', $1, $2)
       on conflict (newsroom_id, kind, key) do nothing`,
      [
        job.pickId,
        JSON.stringify({ series: pick.series, week: pick.week, slot: pick.slot.toISOString() }),
      ],
    );
    return "skipped";
  });
}
