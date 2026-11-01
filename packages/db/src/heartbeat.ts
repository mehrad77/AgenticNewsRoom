// Heartbeats and outages (D128): every worker beats every 30 seconds through anr.beat(), which
// records a gap of more than 3 minutes as a worker's or the host's outage, by Postgres's clock.
import type { Pool } from "./index.ts";

/** Every worker that beats; /healthz expects each to have beaten within STALE_MINUTES. */
export const WORKERS = ["agents", "publisher", "ingestion", "verifier", "web", "api"] as const;
export type Worker = (typeof WORKERS)[number];

export const HEARTBEAT_MS = 30_000;
export const STALE_MINUTES = 3;

/** One beat; says which outage it recorded, if it closed a gap. `at` is for tests only. */
export async function beat(
  db: Pick<Pool, "query">,
  worker: string,
  at?: Date,
): Promise<"worker" | "host" | null> {
  const { rows } = await db.query<{ recorded: "worker" | "host" | null }>(
    at ? "select anr.beat($1, $2) as recorded" : "select anr.beat($1) as recorded",
    at ? [worker, at] : [worker],
  );
  return rows[0]?.recorded ?? null;
}

/**
 * Beats now and every 30 seconds until stopped. A failed beat is logged and the next one tried: a
 * worker that cannot reach Postgres is down anyway, and the gap shows once it is back.
 */
export function startHeartbeat(pool: Pick<Pool, "query">, worker: Worker): () => void {
  const once = () =>
    beat(pool, worker)
      .then((recorded) => {
        if (recorded) console.warn(`[${worker}] back after a ${recorded} outage`);
      })
      .catch((error: Error) => console.error(`[${worker}] heartbeat: ${error.message}`));
  void once();
  const timer = setInterval(once, HEARTBEAT_MS);
  // Never what keeps a process alive.
  timer.unref();
  return () => clearInterval(timer);
}

export interface Health {
  ok: boolean;
  /** Workers whose last beat is too old, or who never beat. */
  late: string[];
}

/** For /healthz: Postgres answers and every worker beat within STALE_MINUTES. */
export async function health(db: Pick<Pool, "query">): Promise<Health> {
  const { rows } = await db.query<{ worker: string }>(
    `select worker from heartbeats
     where beat_at > now() - make_interval(mins => $1)`,
    [STALE_MINUTES],
  );
  const fresh = new Set(rows.map((r) => r.worker));
  const late = WORKERS.filter((w) => !fresh.has(w));
  return { ok: late.length === 0, late };
}
