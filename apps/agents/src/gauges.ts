// Platform gauges (D139, D158): every minute the agents worker reads Postgres and caches what it
// found; observable instruments report the cache at each export, so a slow query never stalls one.
// Each newsroom is read inside withNewsroom(), under its own row-level security; Grafana never
// touches Postgres. Slot and hold counts are cumulative counts of rows, so they survive restarts.

import { budgetState, type Pool, withNewsroom } from "@anr/db";
import { type Meter, metrics, type ObservableResult } from "@opentelemetry/api";

export const GAUGES_EVERY_MS = 60_000;

/** The queues the desk may drain (D144), reported 0 or 1 so every series exists. */
const DRAINABLE = [
  "ingest-source",
  "ingest-media",
  "agent-run",
  "gate",
  "podcast-audio",
  "plan",
  "channel-check",
  "channel-stats",
] as const;
const BACKUP_KINDS = ["full", "diff", "check"] as const;
const OUTAGE_KINDS = ["worker", "host"] as const;

export interface NewsroomGauges {
  slug: string;
  /** Slots by outcome (D158): published within grace, after it, or missed. */
  slots: { onTime: number; late: number; missed: number };
  /** Every time code sent a publication to an editor. */
  holds: number;
  /** Policy checks that held a publication, by reason. */
  holdReasons: Record<string, number>;
  withEditor: number;
  spentUsd: number;
  budgetUsd: number;
}

export interface PlatformGauges {
  /** Seconds since the oldest job waiting in each queue became due. */
  oldestJobAge: Record<string, number>;
  drained: string[];
  heartbeatAge: Record<string, number>;
  outages: Record<string, { count: number; seconds: number }>;
  /** Per backup kind: the latest finished run's result and the last success, in Unix seconds. */
  backups: Record<string, { lastOk: boolean | null; lastSuccess: number | null }>;
  /** Only where WAL archiving is on. */
  wal: { ageSeconds: number | null; ok: boolean; failed: number } | null;
  postgresBytes: number;
}

export interface Snapshot {
  at: number;
  platform: PlatformGauges;
  newsrooms: NewsroomGauges[];
  /** Newsrooms whose read failed this time; their gauges keep their last values. */
  failed: string[];
}

/** One newsroom's numbers, read under its own tenancy setting. */
export function collectNewsroom(pool: Pool, newsroomId: string): Promise<NewsroomGauges> {
  return withNewsroom(pool, newsroomId, async (client) => {
    const { rows } = await client.query<{
      slug: string;
      on_time: number;
      late: number;
      missed: number;
      holds: number;
      with_editor: number;
    }>(
      `with missed as (select key from notices where kind = 'slot-missed'),
            sent as (
              select coalesce(p.published_late, p.published_at > p.slot + f.grace) as late
              from publications p
              join series s on s.id = p.series_id
              join formats f on f.id = s.format_id
              -- Imported pieces (D172) never had a slot to keep.
              where p.published_at is not null and p.origin = 'pipeline'
                and not exists (select from missed m where m.key = p.id::text))
       select n.slug,
              (select count(*) from sent where not late)::int as on_time,
              (select count(*) from sent where late)::int as late,
              -- A publication's miss counts once; a slot never assigned (key series:slot) once per
              -- language of its series, as its publications would have.
              (select coalesce(sum(case when m.key ~ '^[0-9a-f-]{36}$' then 1
                                        else coalesce(cardinality(s.languages), 1) end), 0)
               from missed m
               left join series s on s.slug = split_part(m.key, ':', 1))::int as missed,
              (select count(*) from audit_log
               where entity = 'publications' and action = 'hold')::int as holds,
              (select count(*) from publications where status = 'with-editor')::int as with_editor
       from newsrooms n where n.id = anr.current_newsroom_id()`,
    );
    const row = rows[0];
    if (!row) throw new Error(`newsroom ${newsroomId} not found`);
    const { rows: reasons } = await client.query<{ name: string; count: number }>(
      `select name, count(*)::int as count from checks
       where kind = 'policy' and result <> 'pass' group by name`,
    );
    const budget = await budgetState(client);
    return {
      slug: row.slug,
      slots: { onTime: row.on_time, late: row.late, missed: row.missed },
      holds: row.holds,
      holdReasons: Object.fromEntries(reasons.map((r) => [r.name, r.count])),
      withEditor: row.with_editor,
      spentUsd: budget.spentUsd,
      budgetUsd: budget.monthlyUsd,
    };
  });
}

/** What belongs to no newsroom: queues, heartbeats, outages, backups, WAL archiving. */
export async function collectPlatform(pool: Pick<Pool, "query">): Promise<PlatformGauges> {
  const [queues, drains, beats, outages, backups, wal, size] = await Promise.all([
    pool.query<{ name: string; age: number }>(
      `select name, extract(epoch from now() - min(start_after))::float8 as age
       from pgboss.job where state in ('created', 'retry') and start_after <= now()
       group by name`,
    ),
    pool.query<{ queue: string }>("select queue from queue_drains"),
    pool.query<{ worker: string; age: number }>(
      "select worker, extract(epoch from now() - beat_at)::float8 as age from heartbeats",
    ),
    pool.query<{ kind: string; count: number; seconds: number }>(
      `select kind, count(*)::int as count,
              coalesce(sum(extract(epoch from ended_at - started_at)), 0)::float8 as seconds
       from outages group by kind`,
    ),
    pool.query<{ kind: string; last_ok: boolean | null; last_success: number | null }>(
      `select k.kind,
              (select ok from backup_runs b where b.kind = k.kind and b.finished_at is not null
               order by b.finished_at desc limit 1) as last_ok,
              (select extract(epoch from max(finished_at))::float8 from backup_runs b
               where b.kind = k.kind and b.ok) as last_success
       from unnest($1::text[]) as k (kind)`,
      [BACKUP_KINDS],
    ),
    pool.query<{ on: boolean; age: number | null; failed: number; failed_since: boolean }>(
      `select current_setting('archive_mode') <> 'off' as on,
              extract(epoch from now() - last_archived_time)::float8 as age,
              failed_count::int as failed,
              coalesce(last_failed_time > coalesce(last_archived_time, '-infinity'), false)
                as failed_since
       from pg_stat_archiver`,
    ),
    pool.query<{ bytes: string }>("select pg_database_size(current_database()) as bytes"),
  ]);
  const archiver = wal.rows[0];
  return {
    oldestJobAge: Object.fromEntries(queues.rows.map((r) => [r.name, r.age])),
    drained: drains.rows.map((r) => r.queue),
    heartbeatAge: Object.fromEntries(beats.rows.map((r) => [r.worker, r.age])),
    outages: Object.fromEntries(
      outages.rows.map((r) => [r.kind, { count: r.count, seconds: r.seconds }]),
    ),
    backups: Object.fromEntries(
      backups.rows.map((r) => [r.kind, { lastOk: r.last_ok, lastSuccess: r.last_success }]),
    ),
    // The WAL SLO (technical design): the last segment at most 10 minutes old, no failure since.
    wal: archiver?.on
      ? {
          ageSeconds: archiver.age,
          ok: archiver.age !== null && archiver.age <= 600 && !archiver.failed_since,
          failed: archiver.failed,
        }
      : null,
    postgresBytes: Number(size.rows[0]?.bytes ?? 0),
  };
}

/** Everything, once. A newsroom that fails to read is named in `failed`. */
export async function collect(pool: Pool): Promise<Snapshot> {
  const platform = await collectPlatform(pool);
  const { rows } = await pool.query<{ id: string; slug: string }>(
    "select id, slug from newsrooms order by slug",
  );
  const newsrooms: NewsroomGauges[] = [];
  const failed: string[] = [];
  for (const { id, slug } of rows) {
    try {
      newsrooms.push(await collectNewsroom(pool, id));
    } catch (error) {
      failed.push(slug);
      console.error(`[gauges] newsroom ${slug}: ${(error as Error).message}`);
    }
  }
  return { at: Date.now() / 1000, platform, newsrooms, failed };
}

/**
 * Registers the observable instruments over whatever snapshot `current` returns. The SDK keeps
 * exporting a series' last value once it stops being observed, so every series that ever existed
 * is observed each time: a queue with no due job reports 0, not its last age.
 */
export function observeGauges(current: () => Snapshot | null, meter: Meter): void {
  const queues = new Set<string>(DRAINABLE);
  const each = (fn: (s: Snapshot, r: ObservableResult) => void) => (result: ObservableResult) => {
    const s = current();
    if (s) fn(s, result);
  };
  const room = (n: NewsroomGauges) => ({ "anr.newsroom": n.slug });

  meter
    .createObservableGauge("anr.gauges.collected", {
      description: "When the platform gauges were last read, in Unix seconds",
      unit: "s",
    })
    .addCallback(each((s, r) => r.observe(s.at)));
  meter
    .createObservableGauge("anr.gauges.newsroom_ok", {
      description: "1 if the newsroom's gauges were read this time, 0 if the read failed",
    })
    .addCallback(
      each((s, r) => {
        for (const n of s.newsrooms) r.observe(1, room(n));
        for (const slug of s.failed) r.observe(0, { "anr.newsroom": slug });
      }),
    );

  meter
    .createObservableCounter("anr.slots", {
      description: "Slots by outcome: sent within grace (on-time), after it (late), or missed",
      unit: "{slot}",
    })
    .addCallback(
      each((s, r) => {
        for (const n of s.newsrooms) {
          r.observe(n.slots.onTime, { ...room(n), "anr.slot.outcome": "on-time" });
          r.observe(n.slots.late, { ...room(n), "anr.slot.outcome": "late" });
          r.observe(n.slots.missed, { ...room(n), "anr.slot.outcome": "missed" });
        }
      }),
    );
  meter
    .createObservableCounter("anr.publications.holds", {
      description: "Publications code sent to an editor",
      unit: "{hold}",
    })
    .addCallback(
      each((s, r) => {
        for (const n of s.newsrooms) r.observe(n.holds, room(n));
      }),
    );
  meter
    .createObservableCounter("anr.publications.hold_reasons", {
      description: "Policy checks that held a publication, by reason",
      unit: "{check}",
    })
    .addCallback(
      each((s, r) => {
        for (const n of s.newsrooms)
          for (const [reason, count] of Object.entries(n.holdReasons))
            r.observe(count, { ...room(n), "anr.hold.reason": reason });
      }),
    );
  meter
    .createObservableGauge("anr.publications.with_editor", {
      description: "Publications waiting for an editor",
      unit: "{publication}",
    })
    .addCallback(
      each((s, r) => {
        for (const n of s.newsrooms) r.observe(n.withEditor, room(n));
      }),
    );
  meter
    .createObservableGauge("anr.spend.month_usd", {
      description: "Model spend this month, in US dollars",
      unit: "{USD}",
    })
    .addCallback(
      each((s, r) => {
        for (const n of s.newsrooms) r.observe(n.spentUsd, room(n));
      }),
    );
  meter
    .createObservableGauge("anr.budget.month_usd", {
      description: "The monthly model budget, in US dollars",
      unit: "{USD}",
    })
    .addCallback(
      each((s, r) => {
        for (const n of s.newsrooms) r.observe(n.budgetUsd, room(n));
      }),
    );

  meter
    .createObservableGauge("anr.queue.oldest_age", {
      description: "Seconds since the oldest due job of the queue became due; 0 when none waits",
      unit: "s",
    })
    .addCallback(
      each((s, r) => {
        for (const queue of Object.keys(s.platform.oldestJobAge)) queues.add(queue);
        for (const queue of queues)
          r.observe(s.platform.oldestJobAge[queue] ?? 0, { "anr.queue": queue });
      }),
    );
  meter
    .createObservableGauge("anr.queue.drained", {
      description: "1 while the queue is drained from the desk",
    })
    .addCallback(
      each((s, r) => {
        for (const queue of DRAINABLE)
          r.observe(s.platform.drained.includes(queue) ? 1 : 0, { "anr.queue": queue });
      }),
    );
  meter
    .createObservableGauge("anr.heartbeat.age", {
      description: "Seconds since the worker's last heartbeat",
      unit: "s",
    })
    .addCallback(
      each((s, r) => {
        for (const [worker, age] of Object.entries(s.platform.heartbeatAge))
          r.observe(age, { "anr.worker": worker });
      }),
    );
  meter
    .createObservableCounter("anr.outages", {
      description: "Worker and host outages recorded",
      unit: "{outage}",
    })
    .addCallback(
      each((s, r) => {
        for (const kind of OUTAGE_KINDS)
          r.observe(s.platform.outages[kind]?.count ?? 0, { "anr.outage.kind": kind });
      }),
    );
  meter
    .createObservableCounter("anr.outages.duration", {
      description: "Time spent in recorded outages",
      unit: "s",
    })
    .addCallback(
      each((s, r) => {
        for (const kind of OUTAGE_KINDS)
          r.observe(s.platform.outages[kind]?.seconds ?? 0, { "anr.outage.kind": kind });
      }),
    );
  meter
    .createObservableGauge("anr.backup.last_ok", {
      description: "1 if the latest finished backup run of the kind succeeded, 0 if it failed",
    })
    .addCallback(
      each((s, r) => {
        for (const [kind, b] of Object.entries(s.platform.backups))
          if (b.lastOk !== null) r.observe(b.lastOk ? 1 : 0, { "anr.backup.kind": kind });
      }),
    );
  meter
    .createObservableGauge("anr.backup.last_success", {
      description: "When a backup run of the kind last succeeded, in Unix seconds",
      unit: "s",
    })
    .addCallback(
      each((s, r) => {
        for (const [kind, b] of Object.entries(s.platform.backups))
          if (b.lastSuccess !== null) r.observe(b.lastSuccess, { "anr.backup.kind": kind });
      }),
    );
  meter
    .createObservableGauge("anr.wal.archive_age", {
      description: "Seconds since the last WAL segment was archived",
      unit: "s",
    })
    .addCallback(
      each((s, r) => {
        const age = s.platform.wal?.ageSeconds;
        if (age !== null && age !== undefined) r.observe(age);
      }),
    );
  meter
    .createObservableGauge("anr.wal.ok", {
      description:
        "1 while the last archived segment is at most 10 minutes old and none failed since",
    })
    .addCallback(
      each((s, r) => {
        if (s.platform.wal) r.observe(s.platform.wal.ok ? 1 : 0);
      }),
    );
  meter
    .createObservableCounter("anr.wal.failed", {
      description: "Failed WAL archive attempts since statistics were reset",
      unit: "{attempt}",
    })
    .addCallback(
      each((s, r) => {
        if (s.platform.wal) r.observe(s.platform.wal.failed);
      }),
    );
  meter
    .createObservableGauge("anr.postgres.size", {
      description: "The database's size on disk",
      unit: "By",
    })
    .addCallback(each((s, r) => r.observe(s.platform.postgresBytes)));
}

/**
 * Reads now and every minute until stopped. A failed read keeps the last snapshot, so the
 * instruments repeat it, and `anr.gauges.collected` stops moving, which GaugesStale watches.
 */
export function startGauges(pool: Pool, everyMs = GAUGES_EVERY_MS): () => void {
  let snapshot: Snapshot | null = null;
  observeGauges(() => snapshot, metrics.getMeter("@anr/agents"));
  const once = async () => {
    try {
      snapshot = await collect(pool);
    } catch (error) {
      console.error(`[gauges] ${(error as Error).message}`);
    }
  };
  void once();
  const timer = setInterval(once, everyMs);
  return () => clearInterval(timer);
}
