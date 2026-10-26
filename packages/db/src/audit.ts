// The audit log: every approval and edit, append-only. Call these inside withNewsroom(), so the
// entry commits or rolls back with the change it records.
import pg from "pg";
import type { Client } from "./index.ts";

/** Who acted: a person at the desk, an agent role, or a code component. */
export type Actor =
  | { kind: "person"; userId: string }
  | { kind: "agent"; role: string }
  | { kind: "code"; name: string };

export interface AuditEntry {
  actor: Actor;
  /** What happened, such as approve, return or edit. */
  action: string;
  /** The table acted on, and the row. */
  entity: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}

/** Appends one entry for the transaction's newsroom; returns its id. */
export async function recordAudit(client: Client, entry: AuditEntry): Promise<string> {
  const { actor } = entry;
  const { rows } = await client.query<{ id: string }>(
    `insert into audit_log (actor_kind, actor_user_id, actor_name, action, entity, entity_id, before, after)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [
      actor.kind,
      actor.kind === "person" ? actor.userId : null,
      actor.kind === "agent" ? actor.role : actor.kind === "code" ? actor.name : null,
      entry.action,
      entry.entity,
      entry.entityId,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
    ],
  );
  return rows[0]?.id ?? "";
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * Updates one row and records it with its before and after state. The row is locked first, so
 * nothing changes between the two snapshots. Row-level security applies: a row of another
 * newsroom is not found.
 */
export async function auditedUpdate<T extends Record<string, unknown>>(
  client: Client,
  actor: Actor,
  action: string,
  table: string,
  id: string,
  changes: Record<string, unknown>,
): Promise<T> {
  const columns = Object.keys(changes);
  if (columns.length === 0) throw new Error("auditedUpdate needs at least one change");
  for (const name of [table, ...columns]) {
    if (!IDENTIFIER.test(name)) throw new Error(`not a plain identifier: ${name}`);
  }
  const t = pg.escapeIdentifier(table);
  const { rows: found } = await client.query<T>(`select * from ${t} where id = $1 for update`, [
    id,
  ]);
  const before = found[0];
  if (!before) throw new Error(`${table} ${id} not found`);
  const sets = columns.map((c, i) => `${pg.escapeIdentifier(c)} = $${i + 2}`).join(", ");
  const { rows } = await client.query<T>(`update ${t} set ${sets} where id = $1 returning *`, [
    id,
    ...Object.values(changes),
  ]);
  const after = rows[0] as T;
  await recordAudit(client, { actor, action, entity: table, entityId: id, before, after });
  return after;
}
