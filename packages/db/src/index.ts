import pg from "pg";

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

export function createPool(connectionString = process.env.DATABASE_URL): Pool {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  return new pg.Pool({ connectionString });
}

/**
 * Runs `fn` in a transaction scoped to one newsroom. The newsroom id is a transaction-local
 * setting (`set_config(..., true)`), so a pooled connection never carries it to the next request.
 * Row-level security policies read it with `current_setting('anr.newsroom_id')`.
 */
export async function withNewsroom<T>(
  pool: Pool,
  newsroomId: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("begin");
    await client.query("select set_config('anr.newsroom_id', $1, true)", [newsroomId]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    // Keep the original error; a failed rollback means the connection is unusable.
    await client.query("rollback").catch((rollbackError: Error) => {
      broken = rollbackError;
    });
    throw error;
  } finally {
    // release(err) destroys the client instead of returning it to the pool.
    client.release(broken);
  }
}

export { type Actor, type AuditEntry, auditedUpdate, recordAudit } from "./audit.ts";
export { createBoss, onClient, PGBOSS_SCHEMA } from "./boss.ts";
export {
  type CredentialOwner,
  openCredentials,
  type PlatformKey,
  platformKey,
  rewrapCredentials,
  sealCredentials,
} from "./credentials.ts";
export { loadRootEnv } from "./env.ts";
export { findTenancyProblems, PLATFORM_TABLES } from "./tenancy.ts";
