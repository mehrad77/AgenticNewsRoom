import { QUEUE_OPTIONS, QUEUES } from "@anr/core";
import { PGBOSS_SCHEMA, type Pool } from "@anr/db";
import type {
  FormatSchema,
  NewsroomSchema,
  PolicySchema,
  SeriesSchema,
  SourcesSchema,
} from "@anr/schemas";
import type pg from "pg";
import type { PgBoss } from "pg-boss";
import type { RawConfig } from "./load.ts";
import {
  type DesiredSchedule,
  newsroomSchedules,
  platformSchedules,
  SCHEDULED_QUEUES,
} from "./schedules.ts";
import { validateConfig } from "./validate.ts";

export interface SyncCounts {
  /** Rows created by this sync. */
  added: number;
  /** Rows that were already there (updated in place, ids unchanged; revived if removed). */
  kept: number;
  /** Rows soft-deleted because their item left the config. */
  removed: number;
}
export interface SyncReport {
  formats: SyncCounts;
  newsrooms: SyncCounts;
  beats: SyncCounts;
  sources: SyncCounts;
  series: SyncCounts;
  schedules: { scheduled: number; unscheduled: number };
}

const counts = (): SyncCounts => ({ added: 0, kept: 0, removed: 0 });

const SOURCE_UNITS: Record<string, string> = { m: "minutes", h: "hours", d: "days" };
const interval = (every: string) => `${every.slice(0, -1)} ${SOURCE_UNITS[every.slice(-1)]}`;

/**
 * Loads a validated config tree into Postgres. Runs at deploy as anr_system (it spans newsrooms),
 * in one transaction with the pg-boss schedule changes, so a failed sync changes nothing.
 * Items are upserted on their slug, so ids never change; items that left the config are
 * soft-deleted (removed_at) and revived with the same id if they return.
 */
export async function syncConfig(pool: Pool, boss: PgBoss, config: RawConfig): Promise<SyncReport> {
  const errors = validateConfig(config);
  if (errors.length > 0) throw new Error(`config is invalid:\n${errors.join("\n")}`);

  // Queues must exist before anything is scheduled on them; creating one is idempotent, so an
  // existing queue is also updated to the platform's options.
  for (const queue of Object.values(QUEUES)) {
    const options = QUEUE_OPTIONS[queue];
    await boss.createQueue(queue, options);
    if (options) await boss.updateQueue(queue, options);
  }

  const report: SyncReport = {
    formats: counts(),
    newsrooms: counts(),
    beats: counts(),
    sources: counts(),
    series: counts(),
    schedules: { scheduled: 0, unscheduled: 0 },
  };
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("begin");
    const formatIds = await syncFormats(client, config, report.formats);
    const desired = platformSchedules();
    for (const n of config.newsrooms) {
      desired.push(...(await syncNewsroom(client, n, formatIds, report)));
    }
    report.newsrooms.removed = await softDelete(
      client,
      "newsrooms",
      config.newsrooms.map((n) => n.slug),
    );
    // A removed newsroom's items go with it; they come back with their ids if it returns.
    for (const table of ["beats", "sources", "series"] as const) {
      const { rowCount } = await client.query(
        `update ${table} set removed_at = now(), updated_at = now()
         where removed_at is null
           and newsroom_id in (select id from newsrooms where removed_at is not null)`,
      );
      report[table].removed += rowCount ?? 0;
    }
    report.schedules = await reconcileSchedules(client, boss, desired);
    await client.query("commit");
    return report;
  } catch (error) {
    await client.query("rollback").catch((e: Error) => {
      broken = e;
    });
    throw error;
  } finally {
    client.release(broken);
  }
}

type Row = { id: string; added: boolean };

/** `xmax = 0` is true only for a row this statement inserted, false for one it updated. */
const RETURNING = "returning id, (xmax = 0) as added";

const tally = (c: SyncCounts, row: Row | undefined): string => {
  if (!row) throw new Error("upsert returned no row");
  if (row.added) c.added++;
  else c.kept++;
  return row.id;
};

async function softDelete(
  client: pg.PoolClient,
  table: string,
  keep: string[],
  newsroomId?: string,
): Promise<number> {
  const scope = newsroomId ? "newsroom_id = $2 and" : "";
  const { rowCount } = await client.query(
    `update ${table} set removed_at = now(), updated_at = now()
     where ${scope} removed_at is null and not (slug = any($1))`,
    newsroomId ? [keep, newsroomId] : [keep],
  );
  return rowCount ?? 0;
}

async function syncFormats(
  client: pg.PoolClient,
  config: RawConfig,
  c: SyncCounts,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const slug of config.formats) {
    const meta = config.formatMeta[slug] as FormatSchema;
    const { rows } = await client.query<Row>(
      `insert into formats (slug, genre, ninjs_type) values ($1, $2, $3)
       on conflict (slug) do update set genre = excluded.genre, ninjs_type = excluded.ninjs_type,
         updated_at = now(), removed_at = null
       ${RETURNING}`,
      [slug, meta.genre, meta.ninjs_type],
    );
    ids.set(slug, tally(c, rows[0]));
  }
  c.removed = await softDelete(client, "formats", config.formats);
  return ids;
}

async function syncNewsroom(
  client: pg.PoolClient,
  raw: RawConfig["newsrooms"][number],
  formatIds: Map<string, string>,
  report: SyncReport,
): Promise<DesiredSchedule[]> {
  const n = raw.newsroom as NewsroomSchema;
  const { beats, ...policy } = raw.policy as PolicySchema;
  const { rows } = await client.query<Row>(
    `insert into newsrooms
       (slug, subdomain, name, languages, timezone, editor_in_chief, corrections_owner, planning, policy)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (slug) do update set subdomain = excluded.subdomain, name = excluded.name,
       languages = excluded.languages, timezone = excluded.timezone,
       editor_in_chief = excluded.editor_in_chief, corrections_owner = excluded.corrections_owner,
       planning = excluded.planning, policy = excluded.policy, updated_at = now(), removed_at = null
     ${RETURNING}`,
    [
      n.slug,
      n.subdomain,
      n.name,
      n.languages,
      n.timezone,
      n.editor_in_chief,
      n.corrections_owner,
      n.planning,
      policy,
    ],
  );
  const newsroomId = tally(report.newsrooms, rows[0]);

  for (const [slug, beat] of Object.entries(beats)) {
    const { rows } = await client.query<Row>(
      `insert into beats (newsroom_id, slug, status, media_topics, description)
       values ($1, $2, $3, $4, $5)
       on conflict (newsroom_id, slug) do update set status = excluded.status,
         media_topics = excluded.media_topics, description = excluded.description,
         updated_at = now(), removed_at = null
       ${RETURNING}`,
      [newsroomId, slug, beat.status, beat.media_topics, beat.description ?? null],
    );
    tally(report.beats, rows[0]);
  }
  report.beats.removed += await softDelete(client, "beats", Object.keys(beats), newsroomId);

  const sources = (raw.sources ?? []) as SourcesSchema;
  const scheduledSources = [];
  for (const s of sources) {
    const { rows } = await client.query<Row>(
      `insert into sources (newsroom_id, slug, kind, url, publisher, tier, fetch_every, use,
         terms_checked, terms_note, fetch_pages)
       values ($1, $2, $3, $4, $5, $6, $7::interval, $8, $9, $10, $11)
       on conflict (newsroom_id, slug) do update set kind = excluded.kind, url = excluded.url,
         publisher = excluded.publisher, tier = excluded.tier, fetch_every = excluded.fetch_every,
         use = excluded.use, terms_checked = excluded.terms_checked,
         terms_note = excluded.terms_note, fetch_pages = excluded.fetch_pages, updated_at = now(),
         removed_at = null
       ${RETURNING}`,
      [
        newsroomId,
        s.id,
        s.kind,
        s.url,
        s.publisher ?? null,
        s.tier,
        interval(s.every),
        s.use ?? "leads",
        s.terms_checked ?? null,
        s.terms_note ?? null,
        s.pages ?? true,
      ],
    );
    scheduledSources.push({ ...s, id: tally(report.sources, rows[0]) });
  }
  report.sources.removed += await softDelete(
    client,
    "sources",
    sources.map((s) => s.id),
    newsroomId,
  );

  const scheduledSeries = [];
  for (const [slug, s] of Object.entries(raw.series as Record<string, SeriesSchema>)) {
    const { format, languages, ...rest } = s;
    const { rows } = await client.query<Row>(
      `insert into series (newsroom_id, slug, format_id, languages, config) values ($1, $2, $3, $4, $5)
       on conflict (newsroom_id, slug) do update set format_id = excluded.format_id,
         languages = excluded.languages, config = excluded.config, updated_at = now(), removed_at = null
       ${RETURNING}`,
      [newsroomId, slug, formatIds.get(format), languages, rest],
    );
    scheduledSeries.push({ ...s, id: tally(report.series, rows[0]) });
  }
  report.series.removed += await softDelete(client, "series", Object.keys(raw.series), newsroomId);

  return newsroomSchedules(newsroomId, n.timezone, scheduledSources, scheduledSeries);
}

/**
 * Makes pg-boss's schedules on the config-owned queues exactly the desired set, inside the
 * sync's transaction (pg-boss runs its statements through the `db` adapter).
 */
async function reconcileSchedules(
  client: pg.PoolClient,
  boss: PgBoss,
  desired: DesiredSchedule[],
): Promise<SyncReport["schedules"]> {
  const db = { executeSql: (text: string, values?: unknown[]) => client.query(text, values) };
  const id = (queue: string, key: string) => `${queue}\u0000${key}`;
  const wanted = new Map(desired.map((d) => [id(d.queue, d.key), d]));
  let unscheduled = 0;
  // Read through the transaction, unpaged: getSchedules() returns at most one page.
  const { rows: existing } = await client.query<{ name: string; key: string }>(
    `select name, key from ${PGBOSS_SCHEMA}.schedule where name = any($1)`,
    [SCHEDULED_QUEUES],
  );
  for (const s of existing) {
    if (wanted.has(id(s.name, s.key))) continue;
    await boss.unschedule(s.name, s.key, { db });
    unscheduled++;
  }
  for (const d of desired) {
    await boss.schedule(d.queue, d.cron, d.data, { tz: d.tz, key: d.key, missed: d.missed, db });
  }
  return { scheduled: desired.length, unscheduled };
}
