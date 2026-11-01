import type pg from "pg";
import { PGBOSS_SCHEMA } from "./boss.ts";

/** Tables without `newsroom_id`, each with the reason it is not a tenant table. */
export const PLATFORM_TABLES: Readonly<Record<string, string>> = {
  newsrooms: "the tenants themselves",
  formats: "shared by every newsroom (config/formats)",
  users: "a person can belong to several newsrooms; memberships are per newsroom",
  schema_migrations: "dbmate's record of applied migrations",
  restores: "a database restore is platform-wide; the publisher holds past-due slots after one",
  platform_settings: "settings of the platform, above every newsroom (the TTS engines on offer)",
  platform_audit_log: "who changed a platform setting; a newsroom's changes go to audit_log",
  heartbeats: "a worker serves every newsroom; its liveness belongs to none (D128)",
  outages: "a worker's or the host's downtime, shared by every newsroom (D128)",
  backup_runs: "one backup holds every newsroom's data (D131)",
  ops_requests: "the platform admin's requests to the host, such as a backup check (D144)",
  queue_drains: "a pg-boss queue serves every newsroom (D144)",
};

const TENANT_FUNCTION = "anr.current_newsroom_id()";
/** The one policy expression allowed, as pg_get_expr() prints it, whitespace removed. */
const TENANT_EXPRESSION = "(newsroom_id=(SELECTanr.current_newsroom_id()AScurrent_newsroom_id))";
const isTenantExpression = (expr: string | null) => expr?.replace(/\s+/g, "") === TENANT_EXPRESSION;

interface Relation {
  name: string;
  kind: string;
  owner: string;
  tenant: boolean;
  rls: boolean;
  forced: boolean;
  invoker: boolean;
  policies: { name: string; using: string | null; check: string | null; everyone: boolean }[];
}

/**
 * Lists every way a schema breaks the tenancy rules (AGENTS.md invariant 6); empty means sound.
 * A tenant table (one with `newsroom_id`) needs RLS enabled and forced, at least one policy, and
 * every policy must be exactly `newsroom_id = (select anr.current_newsroom_id())`, for every role,
 * both when reading (`using`) and writing (`with check`): policies are OR-ed, so a single loose
 * one opens the table. Any other table must be a listed platform table. Views must run as the
 * caller, and tables belong to anr_migrator. Checks every schema but the system ones and pg-boss's,
 * or only `schema` when given.
 */
export async function findTenancyProblems(
  db: Pick<pg.ClientBase, "query">,
  schema?: string,
): Promise<string[]> {
  const { rows } = await db.query<Relation>(
    `select c.relname as name,
            c.relkind as kind,
            pg_get_userbyid(c.relowner) as owner,
            exists (select from pg_attribute a
                    where a.attrelid = c.oid and a.attname = 'newsroom_id' and not a.attisdropped) as tenant,
            c.relrowsecurity as rls,
            c.relforcerowsecurity as forced,
            coalesce('security_invoker=true' = any (c.reloptions), false) as invoker,
            coalesce((select json_agg(json_build_object(
                        'name', p.polname,
                        'using', pg_get_expr(p.polqual, p.polrelid),
                        'check', pg_get_expr(p.polwithcheck, p.polrelid),
                        'everyone', p.polroles = '{0}'))
                      from pg_policy p where p.polrelid = c.oid), '[]') as policies
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p', 'v', 'm')
       and (n.nspname = $1
            or ($1 is null and n.nspname not like 'pg\\_%'
                and n.nspname not in ('information_schema', $2)))
     order by c.relname`,
    [schema ?? null, PGBOSS_SCHEMA],
  );
  const problems: string[] = [];
  for (const r of rows) {
    if (r.kind === "v") {
      if (!r.invoker)
        problems.push(`view ${r.name} must be created with (security_invoker = true)`);
      continue;
    }
    if (r.kind === "m") {
      problems.push(`materialized view ${r.name} is not covered by row-level security`);
      continue;
    }
    if (r.owner !== "anr_migrator")
      problems.push(`table ${r.name} is owned by ${r.owner}, not anr_migrator`);
    if (!r.tenant) {
      if (!(r.name in PLATFORM_TABLES))
        problems.push(`table ${r.name} has no newsroom_id and is not a listed platform table`);
      continue;
    }
    if (!r.rls) problems.push(`table ${r.name} does not enable row level security`);
    if (!r.forced) problems.push(`table ${r.name} does not force row level security`);
    if (r.policies.length === 0) problems.push(`table ${r.name} has no row-level security policy`);
    for (const p of r.policies) {
      if (!p.everyone) problems.push(`policy ${p.name} on ${r.name} applies to some roles only`);
      if (!isTenantExpression(p.using))
        problems.push(`policy ${p.name} on ${r.name} does not read with ${TENANT_FUNCTION}`);
      if (!isTenantExpression(p.check))
        problems.push(
          `policy ${p.name} on ${r.name} does not check writes with ${TENANT_FUNCTION}`,
        );
    }
  }
  return problems;
}
