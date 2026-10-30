// Every minute: each newsroom's scheduled publications whose slot has come, oldest first. Each one
// is published under its own lock, so overlapping sweeps never send a part twice.
import { isPaused, type Pool, withNewsroom } from "@anr/db";
import { holdPublication } from "./hold.ts";
import { type PublishDeps, type PublishOutcome, publishOne, RETRY_WINDOW_MS } from "./publish.ts";

export async function sweepDue(
  deps: PublishDeps,
): Promise<Partial<Record<PublishOutcome, number>>> {
  const now = (deps.now ?? (() => new Date()))();
  const pool: Pool = deps.pool;
  const { rows: newsrooms } = await pool.query<{ id: string }>(
    "select id from newsrooms where removed_at is null",
  );
  const counts: Partial<Record<PublishOutcome, number>> = {};
  for (const { id: newsroomId } of newsrooms) {
    const due = await withNewsroom(pool, newsroomId, async (c) => {
      // A paused newsroom sends nothing; resuming decides what is still on time (D144).
      if (await isPaused(c)) return [];
      const { rows } = await c.query<{ id: string; slot: Date }>(
        "select id, slot from publications where status = 'scheduled' and slot <= $1 order by slot",
        [now],
      );
      return rows;
    });
    for (const { id, slot } of due) {
      // One publication's failure never stops the others. An unexpected error leaves it scheduled
      // and its posts as they are for the next sweep; an hour past its slot a person is told.
      const outcome = await publishOne(deps, newsroomId, id).catch(async (error: Error) => {
        console.error(`[publisher] ${id}: ${error.message}`);
        if (now.getTime() - slot.getTime() <= RETRY_WINDOW_MS) return null;
        await withNewsroom(pool, newsroomId, (c) =>
          holdPublication(c, id, {
            name: "publisher-error",
            result: "error",
            detail: { error: error.message },
          }),
        ).catch(() => {});
        return "held" as const;
      });
      if (outcome) counts[outcome] = (counts[outcome] ?? 0) + 1;
    }
  }
  return counts;
}
