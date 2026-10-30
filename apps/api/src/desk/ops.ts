// The platform admin's Ops page (D144): pause publishing for one newsroom or everywhere, retry a
// failed job, cancel a job that has not started or drain a queue (only where the work ends in a
// hold or is done again), and ask the host for a backup check. Each action is a row workers or
// the host obey, written to platform_audit_log. Nothing here approves, publishes or deletes.
import { DRAINABLE_QUEUES, PUBLISHING_PAUSED_KEY, QUEUES, type QueueName } from "@anr/core";
import {
  auditedUpdate,
  type Client,
  onClient,
  PGBOSS_SCHEMA,
  type Pool,
  STALE_MINUTES,
  WORKERS,
  withNewsroom,
} from "@anr/db";
import type { PgBoss } from "pg-boss";
import { DeskError } from "./errors.ts";

type Actor = { kind: "person"; userId: string };
type Boss = Pick<PgBoss, "retry" | "cancel">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function audit(
  db: Pick<Client, "query">,
  actor: Actor,
  action: string,
  entity: string,
  key: string,
  before: unknown,
  after: unknown,
) {
  await db.query(
    `insert into platform_audit_log (actor_user_id, action, entity, key, before, after)
     values ($1, $2, $3, $4, $5, $6)`,
    [actor.userId, action, entity, key, JSON.stringify(before), JSON.stringify(after)],
  );
}

async function inTransaction<T>(pool: Pool, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function newsroomBySlug(pool: Pool, slug: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "select id from newsrooms where slug = $1 and removed_at is null",
    [slug],
  );
  const id = rows[0]?.id;
  if (!id) throw new DeskError(404, `no newsroom ${slug}`);
  return id;
}

async function pausedEverywhere(db: Pick<Client, "query">): Promise<boolean> {
  const { rows } = await db.query<{ paused: boolean }>(
    "select value = 'true'::jsonb as paused from platform_settings where key = $1",
    [PUBLISHING_PAUSED_KEY],
  );
  return rows[0]?.paused ?? false;
}

async function setPausedEverywhere(client: Client, actor: Actor, paused: boolean) {
  const before = await pausedEverywhere(client);
  await client.query(
    `insert into platform_settings (key, value, updated_by, updated_at) values ($1, $2, $3, now())
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by,
                                     updated_at = excluded.updated_at`,
    [PUBLISHING_PAUSED_KEY, JSON.stringify(paused), actor.userId],
  );
  await audit(
    client,
    actor,
    paused ? "pause" : "resume",
    "platform_settings",
    PUBLISHING_PAUSED_KEY,
    before,
    paused,
  );
}

/**
 * Inside a resumed newsroom: every scheduled publication past its slot by more than its format's
 * grace is held as a missed slot for an editor; the rest send, or finish sending (D129, D144).
 */
export async function holdLate(client: Client, now: Date): Promise<string[]> {
  const { rows } = await client.query<{
    id: string;
    slot: Date;
    series: string;
    language: string;
    grace_ms: number;
  }>(
    `select p.id, p.slot, s.slug as series, p.language,
            extract(epoch from f.grace)::float8 * 1000 as grace_ms
     from publications p join series s on s.id = p.series_id join formats f on f.id = s.format_id
     where p.status = 'scheduled' and p.slot + f.grace < $1
     for update of p`,
    [now],
  );
  for (const p of rows) {
    const late = Math.floor((now.getTime() - p.slot.getTime()) / 60_000);
    await client.query(
      `insert into checks (newsroom_id, publication_id, kind, name, result, detail)
       values (anr.current_newsroom_id(), $1, 'policy', 'missed-slot', 'timed-out', $2)`,
      [
        p.id,
        JSON.stringify({
          slot: p.slot,
          grace_minutes: p.grace_ms / 60_000,
          late_minutes: late,
          paused: true,
        }),
      ],
    );
    await auditedUpdate(client, { kind: "code", name: "ops" }, "hold", "publications", p.id, {
      status: "with-editor",
      updated_at: now,
    });
    await client.query(
      `insert into notices (newsroom_id, kind, key, detail)
       values (anr.current_newsroom_id(), 'slot-missed', $1, $2)
       on conflict (newsroom_id, kind, key) do nothing`,
      [
        p.id,
        JSON.stringify({
          publication: p.id,
          series: p.series,
          language: p.language,
          slot: p.slot.toISOString(),
          late_minutes: late,
        }),
      ],
    );
  }
  return rows.map((r) => r.id);
}

/** Pauses one newsroom (its slug) or, without one, every newsroom. */
export async function pause(pool: Pool, actor: Actor, newsroom?: string): Promise<void> {
  if (newsroom === undefined)
    return inTransaction(pool, (c) => setPausedEverywhere(c, actor, true));
  const id = await newsroomBySlug(pool, newsroom);
  await withNewsroom(pool, id, async (c) => {
    const { rowCount } = await c.query(
      `insert into publishing_pauses (newsroom_id, paused_by) values ($1, $2)
       on conflict (newsroom_id) do nothing`,
      [id, actor.userId],
    );
    if (rowCount) await audit(c, actor, "pause", "publishing_pauses", newsroom, false, true);
  });
}

/** Resumes one newsroom or every newsroom; what is now past its grace is held (holdLate). */
export async function resume(
  pool: Pool,
  actor: Actor,
  newsroom?: string,
  now: Date = new Date(),
): Promise<{ held: string[] }> {
  const held: string[] = [];
  if (newsroom !== undefined) {
    const id = await newsroomBySlug(pool, newsroom);
    await withNewsroom(pool, id, async (c) => {
      const { rowCount } = await c.query("delete from publishing_pauses");
      if (rowCount) await audit(c, actor, "resume", "publishing_pauses", newsroom, true, false);
      // Still paused everywhere: nothing resumes here yet.
      if (!(await pausedEverywhere(c))) held.push(...(await holdLate(c, now)));
    });
    return { held };
  }
  // Held while still paused, so nothing past its grace can send in between (D129, D144).
  const { rows } = await pool.query<{ id: string }>(
    "select id from newsrooms where removed_at is null",
  );
  for (const { id } of rows) {
    await withNewsroom(pool, id, async (c) => {
      // A newsroom paused on its own stays paused.
      const { rowCount } = await c.query("select from publishing_pauses");
      if (!rowCount) held.push(...(await holdLate(c, now)));
    });
  }
  await inTransaction(pool, (c) => setPausedEverywhere(c, actor, false));
  return { held };
}

function queueName(queue: unknown): QueueName {
  if (!(Object.values(QUEUES) as unknown[]).includes(queue))
    throw new DeskError(400, "queue: one of the platform's queues");
  return queue as QueueName;
}

function drainable(queue: QueueName, what: string): void {
  if (!DRAINABLE_QUEUES.includes(queue))
    throw new DeskError(
      403,
      `${what} is not allowed on ${queue}: its work is a deadline, a correction or an editorial choice (D144)`,
    );
}

function jobId(id: unknown): string {
  if (typeof id !== "string" || !UUID.test(id)) throw new DeskError(400, "id: a job id");
  return id;
}

/** Retries a failed job; the publisher still never re-sends a part recorded as unknown (D89). */
export async function retryJob(pool: Pool, boss: Boss, actor: Actor, queue: unknown, id: unknown) {
  const name = queueName(queue);
  const job = jobId(id);
  await inTransaction(pool, async (c) => {
    const { rows } = await c.query<{ state: string }>(
      `select state from ${PGBOSS_SCHEMA}.job where name = $1 and id = $2 for update`,
      [name, job],
    );
    if (rows[0]?.state !== "failed") throw new DeskError(409, "only a failed job can be retried");
    await boss.retry(name, job, { db: onClient(c) });
    await audit(c, actor, "retry", "job", `${name}/${job}`, "failed", "retry");
  });
}

/** Cancels a job that has not started, on an allowed queue only (D144). */
export async function cancelJob(pool: Pool, boss: Boss, actor: Actor, queue: unknown, id: unknown) {
  const name = queueName(queue);
  drainable(name, "cancel");
  const job = jobId(id);
  await inTransaction(pool, async (c) => {
    const { rows } = await c.query<{
      state: string;
      data: { newsroomId?: string; url?: string; agentRunId?: string } | null;
    }>(`select state, data from ${PGBOSS_SCHEMA}.job where name = $1 and id = $2 for update`, [
      name,
      job,
    ]);
    const state = rows[0]?.state;
    // pg-boss would cancel a running job too; the Ops page never does.
    if (state !== "created" && state !== "retry")
      throw new DeskError(409, "only a job that has not started can be cancelled");
    await boss.cancel(name, job, { db: onClient(c) });
    // Nothing is suppressed in silence: the work ends as a failure its newsroom sees.
    const data = rows[0]?.data ?? {};
    if (data.newsroomId) {
      await c.query("select set_config('anr.newsroom_id', $1, true)", [data.newsroomId]);
      if (name === QUEUES.ingestMedia && data.url)
        // The member is told, as when the image could not be fetched (D119).
        await c.query(
          `insert into notices (newsroom_id, kind, key, detail)
           values (anr.current_newsroom_id(), 'media-failed', $1, $2)
           on conflict (newsroom_id, kind, key)
             do update set detail = excluded.detail, read_at = null, created_at = now()`,
          [
            data.url,
            JSON.stringify({
              url: data.url,
              outcome: "cancelled",
              reason: "cancelled on the Ops page",
            }),
          ],
        );
      if (name === QUEUES.agentRun && data.agentRunId)
        // Closed, so the gate's deadline sweep holds its publication and a later redraft runs.
        await c.query(
          `update agent_runs set outcome = 'error', finished_at = now(), detail = $2
           where id = $1 and outcome is null`,
          [data.agentRunId, JSON.stringify({ error: "cancelled on the Ops page" })],
        );
    }
    await audit(c, actor, "cancel", "job", `${name}/${job}`, state, "cancelled");
  });
}

/** Drains a queue (workers take no new job from it within 30 seconds) or lifts the drain. */
export async function setDrain(pool: Pool, actor: Actor, queue: unknown, drained: unknown) {
  const name = queueName(queue);
  drainable(name, "drain");
  if (typeof drained !== "boolean") throw new DeskError(400, "drained: true or false");
  await inTransaction(pool, async (c) => {
    const { rowCount } = drained
      ? await c.query(
          "insert into queue_drains (queue, drained_by) values ($1, $2) on conflict do nothing",
          [name, actor.userId],
        )
      : await c.query("delete from queue_drains where queue = $1", [name]);
    if (rowCount)
      await audit(c, actor, drained ? "drain" : "undrain", "queue_drains", name, !drained, drained);
  });
}

/** Asks the host's backup job for a check now; it runs within 30 seconds (D131, D144). */
export async function requestBackupCheck(pool: Pool, actor: Actor): Promise<{ id: string }> {
  return inTransaction(pool, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "insert into ops_requests (kind, requested_by) values ('backup-check', $1) returning id",
      [actor.userId],
    );
    const id = rows[0]?.id ?? "";
    await audit(c, actor, "request", "ops_requests", id, null, "backup-check");
    return { id };
  });
}

/** Everything the Ops page shows; Grafana shows the history (D139). */
export async function opsState(pool: Pool) {
  const paused = await pausedEverywhere(pool);
  const { rows: newsrooms } = await pool.query<{ id: string; slug: string }>(
    "select id, slug from newsrooms where removed_at is null order by slug",
  );
  const pauses = [];
  for (const n of newsrooms) {
    const pausedAt = await withNewsroom(pool, n.id, async (c) => {
      const { rows } = await c.query<{ paused_at: Date }>(
        "select paused_at from publishing_pauses",
      );
      return rows[0]?.paused_at ?? null;
    });
    pauses.push({ newsroom: n.slug, paused_at: pausedAt?.toISOString() ?? null });
  }
  const slugs = new Map(newsrooms.map((n) => [n.id, n.slug]));
  const { rows: drains } = await pool.query<{ queue: string; drained_at: Date }>(
    "select queue, drained_at from queue_drains",
  );
  const drained = new Map(drains.map((d) => [d.queue, d.drained_at]));
  const { rows: counts } = await pool.query<{ name: string; state: string; n: number }>(
    `select name, state::text, count(*)::int as n from ${PGBOSS_SCHEMA}.job
     where name = any($1) and state in ('created', 'retry', 'active', 'failed')
     group by name, state`,
    [Object.values(QUEUES)],
  );
  const queues = Object.values(QUEUES).map((name) => {
    const n = (state: string) => counts.find((c) => c.name === name && c.state === state)?.n ?? 0;
    return {
      name,
      drainable: DRAINABLE_QUEUES.includes(name),
      drained_at: drained.get(name)?.toISOString() ?? null,
      waiting: n("created") + n("retry"),
      active: n("active"),
      failed: n("failed"),
    };
  });
  const job = (r: { id: string; name: string; newsroom: string | null; at: Date }) => ({
    id: r.id,
    queue: r.name,
    newsroom: r.newsroom ? (slugs.get(r.newsroom) ?? null) : null,
    at: r.at.toISOString(),
  });
  const { rows: failed } = await pool.query<{
    id: string;
    name: string;
    newsroom: string | null;
    at: Date;
    error: string | null;
  }>(
    `select id, name, data->>'newsroomId' as newsroom, completed_on as at,
            left(coalesce(output->>'message', output::text), 300) as error
     from ${PGBOSS_SCHEMA}.job where state = 'failed' and name = any($1)
     order by completed_on desc limit 30`,
    [Object.values(QUEUES)],
  );
  const { rows: waiting } = await pool.query<{
    id: string;
    name: string;
    newsroom: string | null;
    at: Date;
  }>(
    `select id, name, data->>'newsroomId' as newsroom, start_after as at
     from ${PGBOSS_SCHEMA}.job where state in ('created', 'retry') and name = any($1)
     order by start_after limit 50`,
    [DRAINABLE_QUEUES],
  );
  const { rows: backups } = await pool.query(
    `select kind, started_at, finished_at, ok from backup_runs order by started_at desc limit 10`,
  );
  const { rows: requests } = await pool.query(
    `select id, requested_at, picked_at, done_at from ops_requests
     where done_at is null or requested_at > now() - interval '1 day'
     order by requested_at desc limit 10`,
  );
  const { rows: beats } = await pool.query<{ worker: string; beat_at: Date; late: boolean }>(
    `select worker, beat_at, beat_at <= now() - make_interval(mins => $1) as late
     from heartbeats where worker = any($2) order by worker`,
    [STALE_MINUTES, WORKERS],
  );
  const { rows: outages } = await pool.query(
    "select kind, worker, started_at, ended_at from outages order by started_at desc limit 10",
  );
  const iso = (d: Date | null) => d?.toISOString() ?? null;
  return {
    paused_everywhere: paused,
    pauses,
    queues,
    failed: failed.map((r) => ({ ...job(r), error: r.error })),
    waiting: waiting.map(job),
    backups: backups.map((b) => ({
      kind: b.kind,
      started_at: iso(b.started_at),
      finished_at: iso(b.finished_at),
      ok: b.ok,
    })),
    backup_requests: requests.map((r) => ({
      id: r.id,
      requested_at: iso(r.requested_at),
      picked_at: iso(r.picked_at),
      done_at: iso(r.done_at),
    })),
    heartbeats: beats.map((b) => ({ worker: b.worker, beat_at: iso(b.beat_at), late: b.late })),
    outages: outages.map((o) => ({
      kind: o.kind,
      worker: o.worker,
      started_at: iso(o.started_at),
      ended_at: iso(o.ended_at),
    })),
  };
}
