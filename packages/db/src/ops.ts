// The platform admin's Ops controls as workers obey them (D144): a publishing pause, read inside a
// newsroom, and queue drains, polled so a worker stops taking a queue's jobs within 30 seconds.
import { PUBLISHING_PAUSED_KEY } from "@anr/core";
import type { PgBoss } from "pg-boss";
import type { Client, Pool } from "./index.ts";

/**
 * Whether publishing is paused for the transaction's newsroom: its own pause (publishing_pauses,
 * under RLS) or the pause of every newsroom (a platform setting). Call inside withNewsroom().
 */
export async function isPaused(client: Pick<Client, "query">): Promise<boolean> {
  const { rows } = await client.query<{ paused: boolean }>(
    `select exists (select from publishing_pauses)
            or coalesce((select value = 'true'::jsonb from platform_settings where key = $1), false)
              as paused`,
    [PUBLISHING_PAUSED_KEY],
  );
  return rows[0]?.paused ?? false;
}

/** How often a worker reads the drains: under 30 seconds from a drain to its last new job. */
export const DRAIN_POLL_MS = 15_000;

/**
 * Stands in for boss.work() while a worker registers its handlers, then works each queue that is
 * not drained, and checks `queue_drains` every DRAIN_POLL_MS: a newly drained queue's worker
 * stops fetching (running jobs finish; nothing is deleted), and a lifted drain starts it again.
 */
export function drainControl(
  pool: Pick<Pool, "query">,
  boss: Pick<PgBoss, "work" | "offWork">,
  log: (message: string) => void = console.log,
  everyMs = DRAIN_POLL_MS,
) {
  const registered = new Map<string, unknown[]>();
  const working = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  const work = boss.work as (queue: string, ...args: unknown[]) => Promise<string>;

  const sync = async () => {
    const { rows } = await pool.query<{ queue: string }>("select queue from queue_drains");
    const drained = new Set(rows.map((r) => r.queue));
    for (const [queue, args] of registered) {
      if (drained.has(queue) && working.has(queue)) {
        await boss.offWork(queue, { wait: false });
        working.delete(queue);
        log(`[drain] ${queue}: drained, no new jobs`);
      } else if (!drained.has(queue) && !working.has(queue)) {
        await work.call(boss, queue, ...args);
        working.add(queue);
      }
    }
  };

  return {
    /** Pass this to registerJobs() in place of the boss: it records, start() works. */
    boss: {
      work: async (queue: string, ...args: unknown[]) => {
        registered.set(queue, args);
        return queue;
      },
    } as unknown as Pick<PgBoss, "work">,
    async start() {
      await sync();
      timer = setInterval(() => {
        sync().catch((error: Error) => log(`[drain] ${error.message}`));
      }, everyMs);
      timer.unref();
    },
    /** For tests and shutdown: one pass now. */
    sync,
    stop() {
      clearInterval(timer);
    },
    working: () => [...working],
  };
}
