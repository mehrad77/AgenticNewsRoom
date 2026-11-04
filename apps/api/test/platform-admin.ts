// anr_test has at most one platform admin, and the test files that name their own run in
// parallel. Each holds this session lock from its beforeAll to its afterAll, so they take turns.
import type { Pool } from "@anr/db";

export async function holdPlatformAdmin(pool: Pool): Promise<() => Promise<void>> {
  const client = await pool.connect();
  await client.query("select pg_advisory_lock(hashtext('anr-test:platform-admin'))");
  return async () => {
    await client.query("select pg_advisory_unlock(hashtext('anr-test:platform-admin'))");
    client.release();
  };
}
