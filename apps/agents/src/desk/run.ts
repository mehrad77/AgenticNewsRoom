// A desk run (D77): one assignment, one graph, one submit, or a hold with the reason. A graph
// never waits for a person; a run that cannot finish holds its assignment's publications.
import type { AgentRunJob } from "@anr/core";
import { type Pool, withNewsroom } from "@anr/db";
import { AllModelsExhausted, ModelCallFailed } from "@anr/models";
import type { PgBoss } from "pg-boss";
import { budgetState, mayStart, noticeBudget } from "../budget.ts";
import { firstLanguage, formatMeta, formatSchema } from "../context.ts";
import { ToolLoopExceeded } from "../converse.ts";
import type { IngestionClient } from "../ingest.ts";
import { newMeter, type RunModel, TokenCapReached } from "../model.ts";
import { assemblePrompt, readGuides } from "../prompts/assemble.ts";
import { deskRole, deskSteps, type OpinionPolicy } from "../prompts/roles.ts";
import { itemShape } from "../prompts/shapes.ts";
import type { ModelRouter } from "../router.ts";
import { assignmentPublications, finishRun, holdPublications, recordUsage } from "../runs.ts";
import { type LeadText, readLead } from "../tools/leads.ts";
import { researchTools, submitTool, type ToolContext } from "../tools/tools.ts";
import { writeDraft } from "./graph.ts";
import { submitStory } from "./submit.ts";
import type { CitableLead, Draft } from "./validate.ts";

export interface RoleDeps {
  pool: Pool;
  boss: Pick<PgBoss, "send">;
  router: ModelRouter;
  configDir: string;
  /** The run's model for a chain, metered and capped at the format's tokens. */
  makeModel: (chain: readonly string[], tokenCap: number) => RunModel;
  ingestion: Pick<IngestionClient, "requestSource">;
  log?: (line: string) => void;
}

interface DeskInput {
  assignmentId: string;
  angle: string | null;
  series: string;
  seriesConfig: { items?: Record<string, string> };
  seriesLanguages: string[];
  format: string;
  newsroom: string;
  newsroomLanguages: string[];
  opinion: OpinionPolicy;
  beats: { slug: string; status: string; description: string | null }[];
  leadIds: string[];
}

/** Errors that end a desk or renderer run with a hold; anything else is retried by pg-boss. */
export function runFailure(error: unknown): { name: string; message: string } | null {
  if (error instanceof TokenCapReached) return { name: "token-cap", message: error.message };
  if (error instanceof ToolLoopExceeded) return { name: "tool-loop", message: error.message };
  if (error instanceof ModelCallFailed) return { name: "model-error", message: error.message };
  if (error instanceof AllModelsExhausted && !error.transient) {
    return { name: "model-error", message: error.message };
  }
  return null;
}

export async function runDesk(deps: RoleDeps, job: AgentRunJob): Promise<string | null> {
  const loaded = await withNewsroom(deps.pool, job.newsroomId, async (client) => {
    const { rows } = await client.query<DeskInput & { outcome: string | null; role: string }>(
      `select r.outcome, r.role, a.id as "assignmentId", a.angle, s.slug as series,
              s.config as "seriesConfig", s.languages as "seriesLanguages", f.slug as format,
              n.slug as newsroom, n.languages as "newsroomLanguages",
              coalesce(n.policy->>'opinion', 'not_allowed') as opinion,
              array(select al.lead_id from assignment_leads al where al.assignment_id = a.id) as "leadIds",
              coalesce((select json_agg(json_build_object('slug', b.slug, 'status', b.status,
                                                         'description', b.description) order by b.slug)
                        from beats b where b.removed_at is null), '[]') as beats
       from agent_runs r join assignments a on a.id = r.assignment_id
       join series s on s.id = a.series_id join formats f on f.id = s.format_id
       join newsrooms n on n.id = r.newsroom_id
       where r.id = $1`,
      [job.agentRunId],
    );
    const row = rows[0];
    if (!row || row.role !== "desk" || row.outcome !== null) return null;
    const budget = await budgetState(client);
    const verdict = mayStart("desk", budget);
    if (!verdict.ok) {
      await noticeBudget(client, budget);
      await finishRun(client, job.agentRunId, "paused", newMeter(), {
        detail: { reason: verdict.reason },
      });
      const pubs = await assignmentPublications(client, row.assignmentId);
      await holdPublications(
        client,
        pubs.map((p) => p.id),
        {
          name: "budget",
          result: "error",
          detail: { reason: verdict.reason },
        },
      );
      return null;
    }
    return row;
  });
  if (!loaded) return null;

  const language = firstLanguage(loaded.newsroomLanguages, loaded.seriesLanguages);
  const { style, guide } = readGuides(deps.configDir, loaded.newsroom, loaded.format);
  const steps = deskSteps(language, itemShape(formatSchema(deps.configDir, loaded.format)));
  const prompt = assemblePrompt("desk", {
    role: deskRole(loaded.opinion),
    steps: [steps.outline, steps.draft, steps.claims],
    style,
    guide,
    language,
  });

  const readLeads = new Map<string, LeadText>();
  const leads: LeadText[] = [];
  for (const id of loaded.leadIds) {
    const lead = await readLead(deps.pool, job.newsroomId, id);
    if (lead) {
      leads.push(lead);
      readLeads.set(lead.id, lead);
    }
  }
  // Most credible first, then newest: the order the assignment ranked them in (D81).
  leads.sort((a, b) => a.tier - b.tier || (b.published ?? "").localeCompare(a.published ?? ""));

  const ctx: ToolContext = {
    pool: deps.pool,
    newsroomId: job.newsroomId,
    agentRunId: job.agentRunId,
    language,
    ingestion: deps.ingestion,
    readLeads,
  };
  const chain = deps.router.resolve("desk", { format: loaded.format });
  const model = deps.makeModel(chain, formatMeta(deps.configDir, loaded.format).run_tokens);
  const beats = loaded.beats.filter((b) => b.status !== "banned").map((b) => b.slug);
  const citable = () =>
    new Map<string, CitableLead>(
      [...readLeads.values()].map((l) => [
        l.id,
        { text: l.text, language: l.language, withdrawn: l.withdrawn !== null },
      ]),
    );

  const hold = async (name: string, outcome: "invalid" | "error", detail: unknown) =>
    withNewsroom(deps.pool, job.newsroomId, async (client) => {
      if (
        !(await finishRun(client, job.agentRunId, outcome, model.meter, {
          detail,
          promptVersion: prompt.version,
        }))
      ) {
        return null;
      }
      const pubs = await assignmentPublications(client, loaded.assignmentId);
      // A model that failed is not the draft's fault (policy.ts).
      await holdPublications(
        client,
        pubs.map((p) => p.id),
        { name, result: outcome === "error" ? "error" : "fail", detail },
      );
      await noticeBudget(client, await budgetState(client));
      return outcome;
    });

  let outcome: Awaited<ReturnType<typeof writeDraft>>;
  try {
    outcome = await writeDraft(
      {
        model,
        tools: researchTools(ctx),
        steps,
        validation: () => ({
          format: loaded.format,
          language,
          needsStory: true,
          beats,
          leads: citable(),
          media: new Set([...readLeads.values()].flatMap((l) => l.images.map((m) => m.id))),
        }),
      },
      prompt.system,
      { ...loaded, items: loaded.seriesConfig.items ?? {}, language, leads },
    );
  } catch (error) {
    const failure = runFailure(error);
    if (!failure) {
      // Retried (pg-boss, or re-queued after a rate limit): what this attempt spent still counts.
      await keepUsage();
      throw error;
    }
    return hold(failure.name, "error", { error: failure.message });
  }
  if (!outcome.draft) return hold("desk-invalid", "invalid", { errors: outcome.errors });

  // Code calls the run's one write tool with the validated draft.
  const submit = submitTool<Draft>(async (draft) =>
    withNewsroom(deps.pool, job.newsroomId, async (client) => {
      const storyId = await submitStory(client, deps.boss, deps.router, {
        runId: job.agentRunId,
        meter: model.meter,
        promptVersion: prompt.version,
        assignmentId: loaded.assignmentId,
        format: loaded.format,
        languages: loaded.seriesLanguages,
        draft,
      });
      await noticeBudget(client, await budgetState(client));
      return storyId ?? "";
    }),
  );
  try {
    const storyId = String(await submit.invoke({ draft: outcome.draft }));
    return storyId ? "submitted" : null;
  } catch (error) {
    // The submit rolled back with the run's usage; the retry must still count it.
    await keepUsage();
    throw error;
  }

  async function keepUsage() {
    await withNewsroom(deps.pool, job.newsroomId, (c) =>
      recordUsage(c, job.agentRunId, model.meter),
    );
  }
}
