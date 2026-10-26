import { type ConstructorOptions, PgBoss } from "pg-boss";

export const PGBOSS_SCHEMA = "pgboss";

/**
 * A pg-boss instance for a worker or a deploy job. The schema is installed by a migration
 * (anr_migrator), so the runtime roles never run DDL: no install or upgrade, no index rebuilds,
 * no queue-stat partitions, and queues are never partitioned.
 */
export function createBoss(
  connectionString: string,
  applicationName: string,
  options: Partial<ConstructorOptions> = {},
): PgBoss {
  const boss = new PgBoss({
    connectionString,
    application_name: applicationName,
    schema: PGBOSS_SCHEMA,
    migrate: false,
    createSchema: false,
    reindex: false,
    persistQueueStats: false,
    ...options,
  });
  boss.on("error", (error) => console.error(`[${applicationName}] pg-boss:`, error));
  return boss;
}
