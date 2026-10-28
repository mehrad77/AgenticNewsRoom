// Makes a person the platform admin (D113), the operator's way to name the one super admin; a
// previous admin loses the role. Runs as the system role and is written to the platform audit log.
//   pnpm --filter @anr/api desk:admin <email>
import { createPool, loadRootEnv } from "@anr/db";

const [email] = process.argv.slice(2);
if (!email?.includes("@")) {
  console.error("usage: desk:admin <email>");
  process.exit(2);
}
loadRootEnv();
const pool = createPool(process.env.DATABASE_SYSTEM_URL);
const client = await pool.connect();
try {
  await client.query("begin");
  const { rows: before } = await client.query<{ email: string }>(
    "select email from users where platform_admin for update",
  );
  await client.query("update users set platform_admin = false where platform_admin");
  await client.query(
    `insert into users (email, platform_admin) values ($1, true)
     on conflict (lower(email)) do update set platform_admin = true`,
    [email.trim()],
  );
  await client.query(
    `insert into platform_audit_log (actor_name, action, entity, key, before, after)
     values ('desk:admin', 'grant', 'users', 'platform_admin', $1, $2)`,
    [JSON.stringify(before[0]?.email ?? null), JSON.stringify(email.trim())],
  );
  await client.query("commit");
  console.log(`${email} is the platform admin${before[0] ? ` (was ${before[0].email})` : ""}`);
} catch (error) {
  await client.query("rollback");
  throw error;
} finally {
  client.release();
  await pool.end();
}
