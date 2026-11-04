// Reading the audit logs (D190): how a person sees what was done in a newsroom, and what their own
// agent did with a token (D189). A newsroom's log for its members; the platform's for the admin.
import type { Client, Pool } from "@anr/db";
import { DeskError } from "./errors.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUGISH = /^[a-z][a-z0-9_-]*$/;

export interface AuditFilters {
  action?: string;
  entity?: string;
  entity_id?: string;
  /** A person's email. */
  person?: string;
  /** A personal token's id: what was done through it. */
  token?: string;
  since?: string;
  limit?: number;
}

/** Checks the query's filters; unknown or malformed values are a 400, not a silent no-match. */
export function auditFilters(query: Record<string, string | undefined>): AuditFilters {
  const f: AuditFilters = {};
  for (const key of ["action", "entity"] as const) {
    const v = query[key];
    if (v === undefined) continue;
    if (!SLUGISH.test(v))
      throw new DeskError(400, `${key}: a name such as approve or publications`);
    f[key] = v;
  }
  for (const key of ["entity_id", "token"] as const) {
    const v = query[key];
    if (v === undefined) continue;
    if (!UUID.test(v)) throw new DeskError(400, `${key}: an id`);
    f[key] = v;
  }
  if (query.person !== undefined) f.person = query.person.toLowerCase();
  if (query.since !== undefined) {
    if (Number.isNaN(Date.parse(query.since))) throw new DeskError(400, "since: a date or time");
    f.since = new Date(query.since).toISOString();
  }
  if (query.limit !== undefined) {
    const n = Number(query.limit);
    if (!Number.isInteger(n) || n < 1 || n > 500) throw new DeskError(400, "limit: 1 to 500");
    f.limit = n;
  }
  return f;
}

const where = (f: AuditFilters, idColumn: string) => {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    clauses.push(sql.replace("?", `$${params.length}`));
  };
  if (f.action) add("a.action = ?", f.action);
  if (f.entity) add("a.entity = ?", f.entity);
  if (f.entity_id) add(`a.${idColumn} = ?`, f.entity_id);
  if (f.person) add("lower(u.email) = ?", f.person);
  if (f.token) add("a.via_token_id = ?", f.token);
  if (f.since) add("a.at >= ?", f.since);
  params.push(f.limit ?? 100);
  return {
    sql: clauses.length ? `where ${clauses.join(" and ")}` : "",
    params,
    limit: `$${params.length}`,
  };
};

const shape = (r: { at: Date }) => ({ ...r, at: r.at.toISOString() });

/** The newsroom's audit log, newest first. */
export async function newsroomAudit(client: Client, f: AuditFilters) {
  const w = where(f, "entity_id::text");
  const { rows } = await client.query<{ at: Date }>(
    `select a.id, a.at, a.actor_kind, u.email as person, a.actor_name as agent_or_code,
            a.via_token_id as token_id, t.name as token_name,
            a.action, a.entity, a.entity_id, a.before, a.after
     from audit_log a
     left join users u on u.id = a.actor_user_id
     left join personal_tokens t on t.id = a.via_token_id
     ${w.sql}
     order by a.at desc limit ${w.limit}`,
    w.params,
  );
  return rows.map(shape);
}

/** The platform's audit log (settings, ops controls, models, the admin role), newest first. */
export async function platformAudit(pool: Pool, f: AuditFilters) {
  const w = where({ ...f, entity_id: undefined }, "key");
  const { rows } = await pool.query<{ at: Date }>(
    `select a.id, a.at, u.email as person, a.actor_name as code,
            a.via_token_id as token_id, t.name as token_name,
            a.action, a.entity, a.key, a.before, a.after
     from platform_audit_log a
     left join users u on u.id = a.actor_user_id
     left join personal_tokens t on t.id = a.via_token_id
     ${w.sql}
     order by a.at desc limit ${w.limit}`,
    w.params,
  );
  return rows.map(shape);
}
