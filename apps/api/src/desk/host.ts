// Host status for the platform admin (D193): which release runs, the database's migration,
// backups and restores. Read-only: deploys, restores and drills stay commands on the host.
import type { Pool } from "@anr/db";

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

export async function hostStatus(pool: Pool, version: string | undefined) {
  const [deploys, migration, backups, restores] = await Promise.all([
    pool.query<{ tag: string; at: Date; ok: boolean; detail: string | null }>(
      "select tag, at, ok, detail from deploys order by at desc limit 10",
    ),
    pool.query<{ version: string }>("select max(version) as version from schema_migrations"),
    pool.query<{
      kind: string;
      started_at: Date;
      finished_at: Date | null;
      ok: boolean | null;
      detail: string | null;
    }>(
      `select distinct on (kind) kind, started_at, finished_at, ok, detail
       from backup_runs order by kind, started_at desc`,
    ),
    pool.query<{ restored_at: Date; note: string | null }>(
      "select restored_at, note from restores order by restored_at desc limit 5",
    ),
  ]);
  return {
    version: version || null,
    deploys: deploys.rows.map((d) => ({ ...d, at: d.at.toISOString() })),
    migration: migration.rows[0]?.version ?? null,
    backups: backups.rows.map((b) => ({
      ...b,
      started_at: b.started_at.toISOString(),
      finished_at: iso(b.finished_at),
    })),
    restores: restores.rows.map((r) => ({ ...r, restored_at: r.restored_at.toISOString() })),
  };
}
