// A planner run (D103): one task, one conversation, one submit. Themes for an editorial cycle, or
// three candidates for a weekly pick; the Editor-in-Chief decides in the desk. The graph never
// waits for that decision: the pick's deadline is a job queued with the candidates (D104).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentRunJob, type PickDeadlineJob, QUEUES } from "@anr/core";
import { type Client, withNewsroom } from "@anr/db";
import { type BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { budgetState, mayStart, noticeBudget } from "../budget.ts";
import { converse, textOf } from "../converse.ts";
import { MAX_SUBMITS } from "../desk/graph.ts";
import { type RoleDeps, runFailure } from "../desk/run.ts";
import { parseJson } from "../desk/validate.ts";
import { newMeter } from "../model.ts";
import { assemblePrompt } from "../prompts/assemble.ts";
import { PLANNER_CANDIDATES, PLANNER_ROLE, PLANNER_THEMES, retryPrompt } from "../prompts/roles.ts";
import { finishRun, onClient, recordUsage } from "../runs.ts";
import { researchTools, submitTool, type ToolContext } from "../tools/tools.ts";
import {
  candidatesMessage,
  leadProblems,
  newsroomFacts,
  pickFacts,
  themesMessage,
} from "./context.ts";
import {
  type Candidate,
  cycleWeeks,
  MAX_THEMES,
  MIN_THEMES,
  type ThemeProposal,
  validateCandidates,
  validateThemes,
} from "./validate.ts";

/** Input plus output tokens over one planner run; there is no format to take `run_tokens` from. */
export const PLANNER_RUN_TOKENS = 200_000;

export type PlannerTask =
  | { key: string; kind: "themes"; starts: string; ends: string }
  | {
      key: string;
      kind: "candidates";
      series_id: string;
      cycle_id: string;
      week: string;
      slot: string;
      deadline: string;
    };

type Proposal =
  | { kind: "themes"; themes: ThemeProposal[] }
  | { kind: "candidates"; candidates: Candidate[] };

/** The prompt of every planner run; both steps count toward the 5 KB (D75). */
export function plannerPrompt(configDir: string, newsroom: string) {
  return assemblePrompt("planner", {
    role: PLANNER_ROLE,
    steps: [PLANNER_THEMES(`${MIN_THEMES}-${MAX_THEMES}`), PLANNER_CANDIDATES],
    style: readFileSync(join(configDir, "newsrooms", newsroom, "style.md"), "utf8"),
    language: "en",
  });
}

export async function runPlanner(
  deps: RoleDeps,
  job: AgentRunJob,
  now: Date = new Date(),
): Promise<string | null> {
  const loaded = await withNewsroom(deps.pool, job.newsroomId, async (client) => {
    const { rows } = await client.query<{
      role: string;
      outcome: string | null;
      task: PlannerTask;
    }>("select role, outcome, task from agent_runs where id = $1", [job.agentRunId]);
    const run = rows[0];
    if (run?.role !== "planner" || run.outcome !== null || !run.task) return null;
    const budget = await budgetState(client);
    const verdict = mayStart("planner", budget);
    if (!verdict.ok) {
      await noticeBudget(client, budget);
      await finishRun(client, job.agentRunId, "paused", newMeter(), {
        detail: { reason: verdict.reason },
      });
      await planFailed(client, run.task, verdict.reason);
      return null;
    }
    const task = run.task;
    // Candidates for a pick whose deadline has passed would be skipped at once: spend nothing.
    if (task.kind === "candidates" && now >= new Date(task.deadline)) {
      await finishRun(client, job.agentRunId, "timed-out", newMeter(), {
        detail: { reason: "the pick's deadline passed before the run started" },
      });
      await planFailed(client, task, "the pick's deadline passed before the planner could run");
      return null;
    }
    const n = await newsroomFacts(client);
    if (task.kind === "themes") {
      const span = { starts: task.starts, ends: task.ends };
      const weeks = cycleWeeks(span);
      return { task, n, weeks, context: await themesMessage(client, n, span, weeks, now) };
    }
    const facts = await pickFacts(
      client,
      task.series_id,
      task.cycle_id,
      new Date(task.slot),
      n.timezone,
    );
    return { task, n, weeks: [], context: await candidatesMessage(client, n, facts, now) };
  });
  if (!loaded) return null;
  const { task, n, weeks } = loaded;

  const prompt = plannerPrompt(deps.configDir, n.slug);
  const model = deps.makeModel(deps.router.resolve("planner"), PLANNER_RUN_TOKENS);
  const ctx: ToolContext = {
    pool: deps.pool,
    newsroomId: job.newsroomId,
    agentRunId: job.agentRunId,
    language: n.languages[0] ?? "en",
    ingestion: deps.ingestion,
    readLeads: new Map(),
  };
  const tools = researchTools(ctx);
  const messages: BaseMessage[] = [
    new SystemMessage(prompt.system),
    new HumanMessage(loaded.context),
  ];
  const instruction =
    task.kind === "themes" ? PLANNER_THEMES(`${MIN_THEMES}-${MAX_THEMES}`) : PLANNER_CANDIDATES;

  let proposal: Proposal | null = null;
  let errors: string[] = [];
  try {
    for (let attempt = 0; attempt < MAX_SUBMITS && !proposal; attempt++) {
      const turn = await converse(
        model,
        messages,
        attempt === 0 ? instruction : retryPrompt(errors),
        tools,
      );
      messages.push(...turn);
      const parsed = parseJson(textOf(turn.at(-1)), { closeBrackets: true });
      if (typeof parsed === "string") {
        errors = [parsed];
        continue;
      }
      const shaped =
        task.kind === "themes" ? validateThemes(parsed, weeks) : validateCandidates(parsed);
      if (shaped.length > 0 && typeof shaped[0] === "string") {
        errors = shaped as string[];
        continue;
      }
      const items = shaped as (ThemeProposal | Candidate)[];
      errors = await withNewsroom(deps.pool, job.newsroomId, (c) =>
        leadProblems(
          c,
          items.flatMap((i) => i.lead_ids),
        ),
      );
      if (errors.length > 0) continue;
      proposal =
        task.kind === "themes"
          ? { kind: "themes", themes: items as ThemeProposal[] }
          : { kind: "candidates", candidates: items as Candidate[] };
    }
  } catch (error) {
    const failure = runFailure(error);
    if (!failure) {
      // Retried: what this attempt spent still counts (D76).
      await withNewsroom(deps.pool, job.newsroomId, (c) =>
        recordUsage(c, job.agentRunId, model.meter),
      );
      throw error;
    }
    errors = [failure.message];
    return fail("error");
  }
  if (!proposal) return fail("invalid");

  // Code calls the run's one write tool with the validated proposal.
  const submit = submitTool<Proposal>(async (valid) =>
    withNewsroom(deps.pool, job.newsroomId, async (client) => {
      if (
        !(await finishRun(client, job.agentRunId, "submitted", model.meter, {
          promptVersion: prompt.version,
        }))
      ) {
        return "";
      }
      if (valid.kind === "themes" && task.kind === "themes") {
        await storeThemes(client, job.agentRunId, task, valid.themes);
      } else if (valid.kind === "candidates" && task.kind === "candidates") {
        await storePick(client, deps, job.agentRunId, task, valid.candidates);
      }
      await noticeBudget(client, await budgetState(client));
      return job.agentRunId;
    }),
  );
  try {
    return String(await submit.invoke({ draft: proposal })) ? "submitted" : null;
  } catch (error) {
    await withNewsroom(deps.pool, job.newsroomId, (c) =>
      recordUsage(c, job.agentRunId, model.meter),
    );
    throw error;
  }

  async function fail(outcome: "invalid" | "error") {
    return withNewsroom(deps.pool, job.newsroomId, async (client) => {
      if (
        !(await finishRun(client, job.agentRunId, outcome, model.meter, {
          detail: { errors },
          promptVersion: prompt.version,
        }))
      ) {
        return null;
      }
      await planFailed(client, task, errors.join("; "));
      return outcome;
    });
  }
}

async function storeThemes(
  client: Client,
  runId: string,
  task: Extract<PlannerTask, { kind: "themes" }>,
  themes: ThemeProposal[],
): Promise<void> {
  for (const t of themes) {
    await client.query(
      `insert into editorial_cycles (newsroom_id, starts, ends, theme, angle, calendar, rationale,
                                     lead_ids, agent_run_id)
       values (anr.current_newsroom_id(), $1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        task.starts,
        task.ends,
        t.theme,
        t.angle,
        JSON.stringify(t.calendar),
        t.rationale,
        [...new Set(t.lead_ids)],
        runId,
      ],
    );
  }
}

/** The candidates and, on the same transaction, the job that skips the slot if none is chosen. */
async function storePick(
  client: Client,
  deps: RoleDeps,
  runId: string,
  task: Extract<PlannerTask, { kind: "candidates" }>,
  candidates: Candidate[],
): Promise<void> {
  const { rows } = await client.query<{ id: string; newsroom_id: string }>(
    `insert into picks (newsroom_id, cycle_id, series_id, week, candidates, deadline, slot, agent_run_id)
     values (anr.current_newsroom_id(), $1, $2, $3, $4, $5, $6, $7)
     on conflict (newsroom_id, series_id, week) do nothing
     returning id, newsroom_id`,
    [
      task.cycle_id,
      task.series_id,
      task.week,
      JSON.stringify(candidates.map((c) => ({ ...c, lead_ids: [...new Set(c.lead_ids)] }))),
      task.deadline,
      task.slot,
      runId,
    ],
  );
  const pick = rows[0];
  if (!pick) return;
  const job: PickDeadlineJob = { newsroomId: pick.newsroom_id, pickId: pick.id };
  await deps.boss.send(QUEUES.pickDeadline, job, {
    db: onClient(client),
    startAfter: new Date(task.deadline),
    singletonKey: pick.id,
  });
}

/** Tells the Editor-in-Chief, once per task, that the planner could not propose. */
async function planFailed(client: Client, task: PlannerTask, reason: string): Promise<void> {
  await client.query(
    `insert into notices (newsroom_id, kind, key, detail)
     values (anr.current_newsroom_id(), 'plan-failed', $1, $2)
     on conflict (newsroom_id, kind, key) do update set detail = excluded.detail, read_at = null`,
    [task.key, JSON.stringify({ task, reason: reason.slice(0, 2000) })],
  );
}
