// Holds any publication still being written or checked shortly before its slot (D80): a run that
// died, a job that used up its retries, a gate that never finished. Nothing waits in silence.
import { type Pool, withNewsroom } from "@anr/db";
import { holdPublications } from "../runs.ts";

/** How long before its slot a publication must have left drafting. */
export const GATE_DEADLINE_MINUTES = 30;

/** How long a publication returned to the desk has for its re-draft, whatever its slot. */
export const REDRAFT_MINUTES = 60;

export async function sweepStuck(
  pool: Pool,
  now: Date = new Date(),
  /** Tests: only these newsrooms, so a clock in the future leaves other tests' rows alone. */
  only?: readonly string[],
): Promise<number> {
  const { rows: all } = await pool.query<{ id: string }>(
    "select id from newsrooms where removed_at is null",
  );
  const newsrooms = only ? all.filter((n) => only.includes(n.id)) : all;
  let held = 0;
  for (const { id } of newsrooms) {
    held += await withNewsroom(pool, id, async (client) => {
      const { rows } = await client.query<{ id: string; status: string; slot: Date }>(
        // A publication an editor returned to the desk has an hour from its return, even past
        // its slot, so the re-draft can finish (D96); after that it is held like any other.
        `select id, status, slot from publications p
         where status in ('assigned', 'drafted')
           and slot - make_interval(mins => $2) <= $1::timestamptz
           and not exists (
             select 1 from audit_log a
             where a.entity = 'publications' and a.entity_id = p.id and a.action = 'return'
               and a.at > $1::timestamptz - make_interval(mins => $3))`,
        [now, GATE_DEADLINE_MINUTES, REDRAFT_MINUTES],
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
