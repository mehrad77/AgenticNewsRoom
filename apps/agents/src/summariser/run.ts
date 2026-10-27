// Summariser runs: one Agent run row and one agent-run job per new lead, then the graph, then
// the submit (the lead's summary and beats) in one transaction with the run's outcome.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type AgentRunJob, QUEUES } from "@anr/core";
import { type Client, type Pool, withNewsroom } from "@anr/db";
import { AllModelsExhausted } from "@anr/models";
import type { PgBoss } from "pg-boss";
import type { ModelRouter } from "../router.ts";
import { rateLimitDelayMs, type Throttle } from "../throttle.ts";
import { type BeforeCall, summarise } from "./graph.ts";
import type { ModelFactory } from "./model.ts";
import { PROMPT_VERSION, type SummariserBeat } from "./prompt.ts";

const mediaTopics = fileURLToPath(
  new URL("../../../../packages/schemas/iptc/mediatopic.json", import.meta.url),
);
let labels: Map<string, string> | undefined;
function topicLabel(qcode: string): string {
  labels ??= new Map(
    (
      JSON.parse(readFileSync(mediaTopics, "utf8")) as {
        concepts: { qcode: string; label: string }[];
      }
    ).concepts.map((c) => [c.qcode, c.label]),
  );
  return labels.get(qcode) ?? qcode;
}

/** pg-boss runs its statements on this client, so the job commits with the run row or not at all. */
const onClient = (client: Client) => ({
  executeSql: (text: string, values?: unknown[]) => client.query(text, values),
});

/** Creates a summariser Agent run per lead and queues it (transactional enqueue). */
export async function enqueueSummaries(
  pool: Pool,
  boss: Pick<PgBoss, "send">,
  router: ModelRouter,
  newsroomId: string,
  leadIds: string[],
): Promise<string[]> {
  // The row names the first model of the chain; it is updated to the one that answered.
  const [first] = router.resolve("summariser");
  if (!first) throw new Error("the summariser chain is empty");
  const choice = router.describe(first);
  const runIds: string[] = [];
  for (const leadId of leadIds) {
    await withNewsroom(pool, newsroomId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into agent_runs (newsroom_id, role, provider, model, prompt_version, input_hash, lead_id)
         select $1, 'summariser', $2, $3, $4,
                encode(sha256(convert_to($4 || ':' || l.content_hash, 'UTF8')), 'hex'), l.id
         from leads l where l.id = $5
         -- One summariser run per lead: a second enqueue of the same lead writes nothing.
         on conflict (newsroom_id, lead_id) where role = 'summariser' do nothing
         returning id`,
        [newsroomId, choice.provider, choice.model, PROMPT_VERSION, leadId],
      );
      const runId = rows[0]?.id;
      if (!runId) return;
      const job: AgentRunJob = { newsroomId, agentRunId: runId };
      await boss.send(QUEUES.agentRun, job, { db: onClient(client) });
      runIds.push(runId);
    });
  }
  return runIds;
}

interface RunRow {
  role: string;
  provider: string;
  model: string;
  outcome: string | null;
  lead_id: string | null;
}

/** The agent-run job for a summariser run. A finished run is never run again (retries). */
export async function runSummariser(
  pool: Pool,
  router: ModelRouter,
  makeModel: ModelFactory,
  job: AgentRunJob,
  beforeCall?: BeforeCall,
): Promise<string | null> {
  const loaded = await withNewsroom(pool, job.newsroomId, async (client) => {
    const run = (
      await client.query<RunRow>(
        "select role, provider, model, outcome, lead_id from agent_runs where id = $1",
        [job.agentRunId],
      )
    ).rows[0];
    if (!run || run.role !== "summariser" || run.outcome !== null || !run.lead_id) return null;
    const lead = (
      await client.query<{ headline: string | null; language: string; body: string }>(
        "select headline, language, body from leads where id = $1",
        [run.lead_id],
      )
    ).rows[0];
    const { rows: beats } = await client.query<{
      slug: string;
      description: string | null;
      media_topics: string[];
    }>("select slug, description, media_topics from beats where removed_at is null order by slug");
    return lead ? { run, lead, beats } : null;
  });
  if (!loaded) return null;
  const beats: SummariserBeat[] = loaded.beats.map((b) => ({
    slug: b.slug,
    description: b.description,
    topics: b.media_topics.map(topicLabel),
  }));
  const model = makeModel(router.resolve("summariser"));
  const outcome = await summarise(model, loaded.lead, beats, beforeCall);

  return withNewsroom(pool, job.newsroomId, async (client) => {
    if (outcome.result) {
      await client.query("update leads set summary = $1 where id = $2", [
        outcome.result.summary,
        loaded.run.lead_id,
      ]);
      await client.query(
        `insert into lead_beats (newsroom_id, lead_id, beat_id)
         select $1, $2, b.id from beats b where b.slug = any($3) and b.removed_at is null
         on conflict do nothing`,
        [job.newsroomId, loaded.run.lead_id, outcome.result.beats],
      );
    }
    const result = outcome.result ? "submitted" : "invalid";
    await client.query(
      `update agent_runs set outcome = $1, tokens_in = $2, tokens_out = $3, finished_at = now(),
              provider = coalesce($5, provider), model = coalesce($6, model)
       where id = $4`,
      [
        result,
        outcome.tokensIn,
        outcome.tokensOut,
        job.agentRunId,
        model.answered?.()?.provider ?? null,
        model.answered?.()?.model ?? null,
      ],
    );
    return result;
  });
}

/**
 * Puts every unfinished summary back in the queue: leads with no summary and no summariser
 * run (an enqueue lost after its ingest), and runs with no outcome and no job at all (a lost
 * enqueue). A run whose job used up its retries is closed as `error`, never re-sent, so a lead
 * the model always fails on costs its retries once. Runs at worker start and after each
 * ingest run, so no lead waits forever.
 */
export async function resumeSummaries(
  pool: Pool,
  boss: Pick<PgBoss, "send">,
  router: ModelRouter,
): Promise<number> {
  const { rows: newsrooms } = await pool.query<{ id: string }>(
    "select id from newsrooms where removed_at is null",
  );
  let resumed = 0;
  for (const { id: newsroomId } of newsrooms) {
    const { orphans, stalled } = await withNewsroom(pool, newsroomId, async (client) => {
      await client.query(
        `update agent_runs r set outcome = 'error', finished_at = now()
         where r.role = 'summariser' and r.outcome is null
           and exists (
             select from pgboss.job j
             where j.name = $1 and j.data->>'agentRunId' = r.id::text and j.state = 'failed')
           and not exists (
             select from pgboss.job j
             where j.name = $1 and j.data->>'agentRunId' = r.id::text
               and j.state in ('created', 'retry', 'active'))`,
        [QUEUES.agentRun],
      );
      const orphanRows = await client.query<{ id: string }>(
        `select l.id from leads l
         where l.summary is null
           and not exists (select from agent_runs r where r.lead_id = l.id and r.role = 'summariser')`,
      );
      const stalledRows = await client.query<{ id: string }>(
        `select r.id from agent_runs r
         where r.role = 'summariser' and r.outcome is null
           and not exists (
             select from pgboss.job j where j.name = $1 and j.data->>'agentRunId' = r.id::text)`,
        [QUEUES.agentRun],
      );
      return {
        orphans: orphanRows.rows.map((r) => r.id),
        stalled: stalledRows.rows.map((r) => r.id),
      };
    });
    resumed += (await enqueueSummaries(pool, boss, router, newsroomId, orphans)).length;
    for (const agentRunId of stalled) {
      const job: AgentRunJob = { newsroomId, agentRunId };
      await boss.send(QUEUES.agentRun, job);
      resumed++;
    }
  }
  return resumed;
}

/** When every model in the chain is cooling down, the job is tried again after this long. */
const EXHAUSTED_DELAY_MS = 60_000;

/** Longer than this until the next slot, and a job is re-queued instead of waiting in-process. */
const MAX_IN_PROCESS_WAIT_MS = 30_000;

export interface SummariserHandlerDeps {
  pool: Pool;
  boss: Pick<PgBoss, "send">;
  router: ModelRouter;
  makeModel: ModelFactory;
  throttle: Throttle;
  log?: (line: string) => void;
}

/**
 * The agent-run handler for summariser runs, paced by the throttle. A rate-limit answer never
 * uses up a pg-boss retry: the job is queued again for after the provider's delay, and the
 * throttle pauses every other call meanwhile.
 */
export function summariserHandler(deps: SummariserHandlerDeps) {
  const log = deps.log ?? console.log;
  const later = async (job: AgentRunJob, ms: number) => {
    await deps.boss.send(QUEUES.agentRun, job, { startAfter: Math.ceil(ms / 1000) });
  };
  return async (job: AgentRunJob): Promise<void> => {
    const wait = deps.throttle.delayMs();
    if (wait > MAX_IN_PROCESS_WAIT_MS) {
      await later(job, wait);
      return;
    }
    try {
      const outcome = await runSummariser(deps.pool, deps.router, deps.makeModel, job, () =>
        deps.throttle.wait(),
      );
      if (outcome) log(`[agents] summariser run ${job.agentRunId}: ${outcome}`);
    } catch (error) {
      // The whole chain rate-limited or down: wait, as a rate-limit answer does.
      const delay =
        error instanceof AllModelsExhausted ? EXHAUSTED_DELAY_MS : rateLimitDelayMs(error);
      if (delay === null) throw error;
      deps.throttle.pauseFor(delay);
      await later(job, delay);
      log(`[agents] model rate limit: run ${job.agentRunId} waits ${Math.ceil(delay / 1000)} s`);
    }
  };
}
