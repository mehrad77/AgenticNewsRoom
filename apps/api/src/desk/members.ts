// A newsroom's people through the API (D190): the Editor-in-Chief adds, changes and removes
// members, which `desk:grant` on the host did before; every change is audited. A newsroom always
// keeps one Editor-in-Chief. The platform admin hands the role to another person (D113).
import { MEMBERSHIP_ROLES, type MembershipRole } from "@anr/core";
import { auditedUpdate, type Client, type PersonActor, type Pool, recordAudit } from "@anr/db";
import { DeskError } from "./errors.ts";
import { audit, inTransaction } from "./ops.ts";

export interface Member {
  user_id: string;
  email: string;
  role: MembershipRole;
  since: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function role(value: unknown): MembershipRole {
  if (!(MEMBERSHIP_ROLES as readonly unknown[]).includes(value))
    throw new DeskError(400, `role: one of ${MEMBERSHIP_ROLES.join(", ")}`);
  return value as MembershipRole;
}

function email(value: unknown): string {
  if (typeof value !== "string" || value.length > 320 || !EMAIL.test(value.trim()))
    throw new DeskError(400, "email: an email address");
  return value.trim().toLowerCase();
}

export async function listMembers(client: Client): Promise<Member[]> {
  const { rows } = await client.query<Member & { since: Date }>(
    `select u.id as user_id, u.email, m.role, m.created_at as since
     from memberships m join users u on u.id = m.user_id
     order by m.role = 'editor-in-chief' desc, u.email`,
  );
  return rows.map((r) => ({ ...r, since: r.since.toISOString() }));
}

async function member(client: Client, userId: string) {
  const { rows } = await client.query<{ id: string; role: MembershipRole; email: string }>(
    `select m.id, m.role, u.email from memberships m join users u on u.id = m.user_id
     where m.user_id = $1 for update of m`,
    [userId],
  );
  const found = rows[0];
  if (!found) throw new DeskError(404, "no such member");
  return found;
}

/**
 * Refuses a change that would leave the newsroom without an Editor-in-Chief. Every chief's row is
 * locked first, so two chiefs demoting each other at once cannot both pass.
 */
async function keepChief(client: Client, userId: string) {
  const { rows } = await client.query<{ user_id: string }>(
    "select user_id from memberships where role = 'editor-in-chief' order by id for update",
  );
  if (!rows.some((r) => r.user_id !== userId))
    throw new DeskError(409, "a newsroom keeps at least one Editor-in-Chief");
}

/** Adds a member by email, creating the user if there is none; they sign in through Access. */
export async function addMember(
  client: Client,
  actor: PersonActor,
  input: Record<string, unknown>,
): Promise<Member> {
  const address = email(input.email);
  const as = role(input.role);
  await client.query("insert into users (email) values ($1) on conflict do nothing", [address]);
  const { rows: users } = await client.query<{ id: string }>(
    "select id from users where lower(email) = $1",
    [address],
  );
  const userId = users[0]?.id as string;
  const { rows } = await client.query<{ id: string; created_at: Date }>(
    `insert into memberships (newsroom_id, user_id, role)
     values (anr.current_newsroom_id(), $1, $2)
     on conflict (newsroom_id, user_id) do nothing
     returning id, created_at`,
    [userId, as],
  );
  const added = rows[0];
  if (!added) throw new DeskError(409, `${address} is already a member`);
  await recordAudit(client, {
    actor,
    action: "add-member",
    entity: "memberships",
    entityId: added.id,
    after: { email: address, role: as },
  });
  return { user_id: userId, email: address, role: as, since: added.created_at.toISOString() };
}

export async function setMemberRole(
  client: Client,
  actor: PersonActor,
  userId: string,
  input: Record<string, unknown>,
): Promise<Member> {
  const to = role(input.role);
  const found = await member(client, userId);
  if (found.role === "editor-in-chief" && to !== "editor-in-chief") await keepChief(client, userId);
  const row = await auditedUpdate<{ role: MembershipRole; created_at: Date }>(
    client,
    actor,
    "set-role",
    "memberships",
    found.id,
    { role: to },
  );
  return {
    user_id: userId,
    email: found.email,
    role: row.role,
    since: row.created_at.toISOString(),
  };
}

export async function removeMember(
  client: Client,
  actor: PersonActor,
  userId: string,
): Promise<{ user_id: string; removed: true }> {
  const found = await member(client, userId);
  if (found.role === "editor-in-chief") await keepChief(client, userId);
  await client.query("delete from memberships where id = $1", [found.id]);
  await recordAudit(client, {
    actor,
    action: "remove-member",
    entity: "memberships",
    entityId: found.id,
    before: { email: found.email, role: found.role },
  });
  return { user_id: userId, removed: true };
}

/** The platform admin hands the role to another signed-up person (D113); there is only one. */
export async function handOverAdmin(
  pool: Pool,
  actor: PersonActor,
  input: Record<string, unknown>,
): Promise<{ email: string; platform_admin: true }> {
  const address = email(input.email);
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      "select id from users where lower(email) = $1",
      [address],
    );
    const to = rows[0];
    if (!to) throw new DeskError(404, "no such person: add them to a newsroom first");
    if (to.id === actor.userId) throw new DeskError(409, "you are the platform admin already");
    await client.query("update users set platform_admin = false where platform_admin");
    await client.query("update users set platform_admin = true where id = $1", [to.id]);
    await audit(client, actor, "hand-over", "users", "platform_admin", actor.userId, to.id);
    return { email: address, platform_admin: true };
  });
}
