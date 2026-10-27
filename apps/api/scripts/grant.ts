// Gives a person a role in a newsroom's desk: the operator's way to add the first Editor-in-Chief
// (D95). Runs as the system role; the membership is written and audited inside the newsroom.
//   pnpm --filter @anr/api desk:grant <newsroom-slug> <email> <editor-in-chief|editor>
import { MEMBERSHIP_ROLES, type MembershipRole } from "@anr/core";
import { createPool, loadRootEnv, recordAudit, withNewsroom } from "@anr/db";

const [slug, email, role] = process.argv.slice(2);
if (!slug || !email?.includes("@") || !MEMBERSHIP_ROLES.includes(role as MembershipRole)) {
  console.error("usage: desk:grant <newsroom-slug> <email> <editor-in-chief|editor>");
  process.exit(2);
}
loadRootEnv();
const pool = createPool(process.env.DATABASE_SYSTEM_URL);
try {
  const { rows } = await pool.query<{ id: string }>(
    "select id from newsrooms where slug = $1 and removed_at is null",
    [slug],
  );
  const newsroomId = rows[0]?.id;
  if (!newsroomId) throw new Error(`no newsroom ${slug}`);
  const { rows: users } = await pool.query<{ id: string }>(
    `insert into users (email) values ($1)
     on conflict (lower(email)) do update set email = users.email returning id`,
    [email.trim()],
  );
  const userId = users[0]?.id ?? "";
  await withNewsroom(pool, newsroomId, async (c) => {
    const { rows: m } = await c.query<{ id: string }>(
      `insert into memberships (newsroom_id, user_id, role) values ($1, $2, $3)
       on conflict (newsroom_id, user_id) do update set role = excluded.role returning id`,
      [newsroomId, userId, role],
    );
    await recordAudit(c, {
      actor: { kind: "code", name: "desk:grant" },
      action: "grant",
      entity: "memberships",
      entityId: m[0]?.id ?? "",
      after: { email: email.trim(), role },
    });
  });
  console.log(`${email} is ${role} of ${slug}`);
} finally {
  await pool.end();
}
