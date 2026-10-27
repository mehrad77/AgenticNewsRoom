// Holds any publication still being written or checked shortly before its slot (D80): a run that
// died, a job that used up its retries, a gate that never finished. Nothing waits in silence.
import { type Pool, withNewsroom } from "@anr/db";
import { holdPublications } from "../runs.ts";

/** How long before its slot a publication must have left drafting. */
export const GATE_DEADLINE_MINUTES = 30;

export async function sweepStuck(pool: Pool, now: Date = new Date()): Promise<number> {
  const { rows: newsrooms } = await pool.query<{ id: string }>(
    "select id from newsrooms where removed_at is null",
  );
  let held = 0;
  for (const { id } of newsrooms) {
    held += await withNewsroom(pool, id, async (client) => {
      const { rows } = await client.query<{ id: string; status: string; slot: Date }>(
        `select id, status, slot from publications
         where status in ('assigned', 'drafted')
           and slot - make_interval(mins => $2) <= $1::timestamptz`,
        [now, GATE_DEADLINE_MINUTES],
      );
      for (const p of rows) {
        await holdPublications(client, [p.id], {
          name: "deadline",
          result: "timed-out",
          detail: { status: p.status, slot: p.slot, minutes_before_slot: GATE_DEADLINE_MINUTES },
        });
      }
      return rows.length;
    });
  }
  return held;
}
