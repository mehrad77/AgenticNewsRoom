import { type ConstructorOptions, PgBoss } from "pg-boss";
import type { Client } from "./index.ts";

export const PGBOSS_SCHEMA = "pgboss";

/**
 * A pg-boss instance for a worker or a deploy job. The schema is installed by a migration
 * (anr_migrator), so the runtime roles never run DDL: no install or upgrade, no index rebuilds,
 * no queue-stat partitions, and queues are never partitioned.
 *
 * pg-boss's own OpenTelemetry support (a no-op until an SDK is registered) wraps each send in a
 * producer span and each job in a consumer span, and stores the trace context of the send in the
 * job's `trace_context` column, so a job continues the trace that sent it (D137).
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
    openTelemetry: { propagateContext: true },
    ...options,
  });
  // The message only: a Postgres error's detail can quote a row's values, and logs are telemetry.
  boss.on("error", (error) => console.error(`[${applicationName}] pg-boss: ${error.message}`));
  return boss;
}

/** pg-boss runs its statements on this client, so a job commits with the rows that need it. */
export const onClient = (client: Client) => ({
  executeSql: (text: string, values?: unknown[]) => client.query(text, values),
});
