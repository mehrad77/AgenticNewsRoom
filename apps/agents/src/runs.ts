// Agent run rows and holds, shared by every role. Call these inside withNewsroom(), so a run's
// outcome, its submit and the jobs it queues commit together or not at all.
import {
  type AgentRole,
  type AgentRunJob,
  type AgentRunOutcome,
  type CheckResult,
  QUEUES,
} from "@anr/core";
import { auditedUpdate, type Client } from "@anr/db";
import type { PgBoss } from "pg-boss";
import type { Meter } from "./model.ts";

/** pg-boss runs its statements on this client, so a job commits with the rows that need it. */
export const onClient = (client: Client) => ({
  executeSql: (text: string, values?: unknown[]) => client.query(text, values),
});

export interface NewRun {
  role: AgentRole;
  /** Provider and model of the chain's first model; updated to the one that answered. */
  provider: string;
  model: string;
  promptVersion: string;
  /** What the run is about, hashed: same input, same hash. */
  input: string;
  assignmentId?: string;
  storyId?: string;
  language?: string;
}

/** Writes an Agent run and queues its job in the same transaction. */
export async function createRun(
  client: Client,
  boss: Pick<PgBoss, "send">,
  run: NewRun,
): Promise<string> {
  const { rows } = await client.query<{ id: string; newsroom_id: string }>(
    `insert into agent_runs (newsroom_id, role, provider, model, prompt_version, input_hash,
                             assignment_id, story_id, language)
     values (anr.current_newsroom_id(), $1, $2, $3, $4,
             encode(sha256(convert_to($5, 'UTF8')), 'hex'), $6, $7, $8)
     returning id, newsroom_id`,
    [
      run.role,
      run.provider,
      run.model,
      run.promptVersion,
      run.input,
      run.assignmentId ?? null,
      run.storyId ?? null,
      run.language ?? null,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("agent run not created");
  const job: AgentRunJob = { newsroomId: row.newsroom_id, agentRunId: row.id };
  await boss.send(QUEUES.agentRun, job, { db: onClient(client) });
  return row.id;
}

/**
 * Closes a run once: its outcome, what its calls used (added to anything an earlier attempt
 * recorded), every family that answered, and why it ended without a submit. Returns false when
 * the run had already finished, so a retried job never submits twice.
 */
export async function finishRun(
  client: Client,
  runId: string,
  outcome: AgentRunOutcome,
  meter: Meter,
  extra: { detail?: unknown; promptVersion?: string } = {},
): Promise<boolean> {
  const { rowCount } = await client.query(
    `update agent_runs set
       outcome = $2, finished_at = now(),
       tokens_in = coalesce(tokens_in, 0) + $3, tokens_out = coalesce(tokens_out, 0) + $4,
       cost_usd = coalesce(cost_usd, 0) + $5,
       families = array(select distinct f from unnest(families || $6::text[]) f order by f),
       provider = coalesce($7, provider), model = coalesce($8, model),
       detail = $9, prompt_version = coalesce($10, prompt_version)
     where id = $1 and outcome is null`,
    [
      runId,
      outcome,
      meter.tokensIn,
      meter.tokensOut,
      meter.costUsd,
      [...meter.families],
      meter.answered?.provider ?? null,
      meter.answered?.model ?? null,
      extra.detail === undefined ? null : JSON.stringify(extra.detail),
      extra.promptVersion ?? null,
    ],
  );
  return rowCount === 1;
}

export interface HoldReason {
  /** Which check, such as desk-invalid or budget. */
  name: string;
  result: Exclude<CheckResult, "pass">;
  detail?: unknown;
}

/**
 * Holds publications for an editor (invariant 5): a policy Check with the reason on each, and
 * status with-editor, written to the audit log. A publication past drafting keeps its status.
 */
export async function holdPublications(
  client: Client,
  publicationIds: readonly string[],
  reason: HoldReason,
): Promise<void> {
  for (const id of publicationIds) {
    await client.query(
      `insert into checks (newsroom_id, publication_id, kind, name, result, detail)
       values (anr.current_newsroom_id(), $1, 'policy', $2, $3, $4)`,
      [id, reason.name, reason.result, JSON.stringify(reason.detail ?? null)],
    );
    const { rows } = await client.query<{ status: string }>(
      "select status from publications where id = $1",
      [id],
    );
    if (rows[0] && ["assigned", "drafted"].includes(rows[0].status)) {
      await auditedUpdate(client, { kind: "code", name: "gate" }, "hold", "publications", id, {
        status: "with-editor",
        updated_at: new Date(),
      });
    }
  }
}

/** The publications made for an assignment, one per language. */
export async function assignmentPublications(
  client: Client,
  assignmentId: string,
): Promise<{ id: string; language: string; status: string }[]> {
  const { rows } = await client.query<{ id: string; language: string; status: string }>(
    "select id, language, status from publications where assignment_id = $1 order by language",
    [assignmentId],
  );
  return rows;
}
