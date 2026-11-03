// Every minute: each newsroom's scheduled publications whose slot has come, oldest first. Each one
// is published under its own lock, so overlapping sweeps never send a part twice.
import { inStoredTrace, isPaused, linkTo, type Pool, withNewsroom } from "@anr/db";
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
      // With the trace started at its assignment, and the ingest spans of the leads it cites.
      const { rows } = await c.query<{
        id: string;
        slot: Date;
        traceparent: string | null;
        leads: string[];
      }>(
        `select p.id, p.slot, p.traceparent,
                array(select distinct l.traceparent from stories s
                      join claims cl on cl.story_id = s.id
                      join claim_sources cs on cs.claim_id = cl.id
                      join leads l on l.id = cs.lead_id
                      where s.assignment_id = p.assignment_id and l.traceparent is not null)
                  as leads
         from publications p where p.status = 'scheduled' and p.slot <= $1 order by p.slot`,
        [now],
      );
      return rows;
    });
    for (const { id, slot, traceparent, leads } of due) {
      // One publication's failure never stops the others. An unexpected error leaves it scheduled
      // and its posts as they are for the next sweep; an hour past its slot a person is told.
      // The send continues the publication's trace, linked to this sweep and to its sources (D137).
      const send = () =>
        inStoredTrace(
          traceparent,
          "publish",
          {
            attributes: { "anr.publication.id": id, "anr.newsroom.id": newsroomId },
            links: leads.flatMap(linkTo),
          },
          async (span) => {
            const outcome = await publishOne(deps, newsroomId, id);
            span.setAttribute("anr.publish.outcome", outcome);
            return outcome;
          },
        );
      const outcome = await send().catch(async (error: Error) => {
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
