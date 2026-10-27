// Who is signed in to the desk: a user by email, and a membership per newsroom (D95). Memberships
// live under row-level security, so they are read newsroom by newsroom with withNewsroom().
import type { Language, MembershipRole } from "@anr/core";
import { type Pool, withNewsroom } from "@anr/db";

export interface Membership {
  newsroomId: string;
  newsroom: string;
  name: Partial<Record<Language, string>>;
  role: MembershipRole;
}

export interface DeskPerson {
  userId: string;
  email: string;
  memberships: Membership[];
}

export async function deskPerson(pool: Pool, email: string): Promise<DeskPerson | null> {
  const { rows: users } = await pool.query<{ id: string; email: string }>(
    "select id, email from users where lower(email) = lower($1)",
    [email],
  );
  const user = users[0];
  if (!user) return null;
  const { rows: newsrooms } = await pool.query<{
    id: string;
    slug: string;
    name: Partial<Record<Language, string>>;
  }>("select id, slug, name from newsrooms where removed_at is null order by slug");
  const memberships: Membership[] = [];
  for (const n of newsrooms) {
    const role = await withNewsroom(pool, n.id, async (c) => {
      const { rows } = await c.query<{ role: MembershipRole }>(
        "select role from memberships where user_id = $1",
        [user.id],
      );
      return rows[0]?.role;
    });
    if (role) memberships.push({ newsroomId: n.id, newsroom: n.slug, name: n.name, role });
  }
  return { userId: user.id, email: user.email, memberships };
}
