// Agent runs at the desk (D190): what each agent did, on which model, at what cost, and how it
// ended. Read-only.
import { AGENT_ROLES } from "@anr/core";
import type { Client } from "@anr/db";
import { DeskError } from "./errors.ts";

const OUTCOMES = ["submitted", "invalid", "error", "timed-out", "running"] as const;

export interface RunFilters {
  role?: string;
  outcome?: string;
  story?: string;
  since?: string;
  limit?: number;
}

export function runFilters(query: Record<string, string | undefined>): RunFilters {
  const f: RunFilters = {};
  if (query.role !== undefined) {
    if (!(AGENT_ROLES as readonly string[]).includes(query.role))
      throw new DeskError(400, `role: one of ${AGENT_ROLES.join(", ")}`);
    f.role = query.role;
  }
  if (query.outcome !== undefined) {
    if (!(OUTCOMES as readonly string[]).includes(query.outcome))
      throw new DeskError(400, `outcome: one of ${OUTCOMES.join(", ")}`);
    f.outcome = query.outcome;
  }
  if (query.story !== undefined) {
    if (!/^[0-9a-f-]{36}$/.test(query.story)) throw new DeskError(400, "story: an id");
    f.story = query.story;
  }
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

const COLUMNS = `id, role, provider, model, prompt_version, tokens_in, tokens_out,
  cost_usd::float as cost_usd, coalesce(outcome, 'running') as outcome, assignment_id, story_id,
  lead_id, language, started_at, finished_at`;

const shape = (r: { started_at: Date; finished_at: Date | null }) => ({
  ...r,
  started_at: r.started_at.toISOString(),
  finished_at: r.finished_at?.toISOString() ?? null,
});

export async function listAgentRuns(client: Client, f: RunFilters) {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    clauses.push(sql.replace("?", `$${params.length}`));
  };
  if (f.role) add("role = ?", f.role);
  if (f.outcome) add("coalesce(outcome, 'running') = ?", f.outcome);
  if (f.story) add("story_id = ?", f.story);
  if (f.since) add("started_at >= ?", f.since);
  params.push(f.limit ?? 100);
  const { rows } = await client.query<{ started_at: Date; finished_at: Date | null }>(
    `select ${COLUMNS} from agent_runs ${clauses.length ? `where ${clauses.join(" and ")}` : ""}
     order by started_at desc limit $${params.length}`,
    params,
  );
  return rows.map(shape);
}

/** One run with what it was asked (`task`) and how it ended (`detail`). */
export async function agentRun(client: Client, id: string) {
  const { rows } = await client.query<{ started_at: Date; finished_at: Date | null }>(
    `select ${COLUMNS}, task, detail from agent_runs where id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new DeskError(404, "no such agent run");
  return shape(row);
}
