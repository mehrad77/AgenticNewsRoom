// A renderer run for another language of a story (D77): the story's claims and first rendition in,
// one rendition in the target language out, items tied to the same claims. No research, so no
// research tools; validation and one retry as for the desk. Other formats and podcast scripts
// arrive with milestone 5.
import type { AgentRunJob } from "@anr/core";
import { withNewsroom } from "@anr/db";
import { AllModelsExhausted, ModelCallFailed } from "@anr/models";
import { type BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { budgetState, mayStart, noticeBudget } from "../budget.ts";
import { formatMeta } from "../context.ts";
import { converse, ToolLoopExceeded, textOf } from "../converse.ts";
import { MAX_SUBMITS } from "../desk/graph.ts";
import type { RoleDeps } from "../desk/run.ts";
import { gateWhenRendered, submitRendition } from "../desk/submit.ts";
import { type Draft, parseJson, validateDraft } from "../desk/validate.ts";
import { newMeter, TokenCapReached } from "../model.ts";
import { assemblePrompt, readGuides } from "../prompts/assemble.ts";
import { RENDERER_ROLE, retryPrompt } from "../prompts/roles.ts";
import { finishRun, holdPublications, recordUsage } from "../runs.ts";
import { submitTool } from "../tools/tools.ts";

interface RendererInput {
  role: string;
  outcome: string | null;
  language: string;
  storyId: string;
  assignmentId: string;
  newsroom: string;
  format: string;
  summary: string;
  claims: { ref: string; kind: string; text: string }[];
  first: Draft["rendition"];
}

export async function runRenderer(deps: RoleDeps, job: AgentRunJob): Promise<string | null> {
  const loaded = await withNewsroom(deps.pool, job.newsroomId, async (client) => {
    const { rows } = await client.query<RendererInput>(
      `select r.role, r.outcome, r.language, r.story_id as "storyId", s.assignment_id as "assignmentId",
              n.slug as newsroom, f.slug as format, s.summary,
              coalesce((select json_agg(json_build_object('ref', c.ref, 'kind', c.kind, 'text', c.text)
                                        order by c.created_at)
                        from claims c where c.story_id = s.id), '[]') as claims,
              (select rd.body from renditions rd where rd.story_id = s.id order by rd.created_at limit 1) as first
       from agent_runs r join stories s on s.id = r.story_id
       join assignments a on a.id = s.assignment_id join series se on se.id = a.series_id
       join formats f on f.id = se.format_id join newsrooms n on n.id = r.newsroom_id
       where r.id = $1`,
      [job.agentRunId],
    );
    const row = rows[0];
    if (!row || row.role !== "renderer" || row.outcome !== null || !row.first) return null;
    const budget = await budgetState(client);
    const verdict = mayStart("renderer", budget);
    if (!verdict.ok) {
      await noticeBudget(client, budget);
      await finishRun(client, job.agentRunId, "paused", newMeter(), {
        detail: { reason: verdict.reason },
      });
      await holdLanguage(client, row, {
        name: "budget",
        result: "error",
        detail: { reason: verdict.reason },
      });
      await gateWhenRendered(client, deps.boss, row.storyId);
      return null;
    }
    return row;
  });
  if (!loaded) return null;

  const { style, guide } = readGuides(deps.configDir, loaded.newsroom, loaded.format);
  const prompt = assemblePrompt("renderer", {
    role: RENDERER_ROLE,
    style,
    guide,
    language: loaded.language,
  });
  const model = deps.makeModel(
    deps.router.resolve("renderer"),
    formatMeta(deps.configDir, loaded.format).run_tokens,
  );
  const claims = loaded.claims.map((c) => `- ${c.ref} (${c.kind}): ${c.text}`).join("\n");
  const messages: BaseMessage[] = [
    new SystemMessage(prompt.system),
    new HumanMessage(
      `Target language: ${loaded.language}\n\nStory: ${loaded.summary}\n\nClaims:\n${claims}\n\nRendition to write in ${loaded.language}:\n${JSON.stringify(loaded.first)}`,
    ),
  ];

  let draft: Draft | null = null;
  let errors: string[] = [];
  try {
    for (let attempt = 0; attempt < MAX_SUBMITS && !draft; attempt++) {
      const ask = attempt === 0 ? "Write the rendition now." : retryPrompt(errors);
      const turn = await converse(model, messages, ask);
      messages.push(...turn);
      const parsed = parseJson(textOf(turn.at(-1)));
      const result =
        typeof parsed === "string"
          ? [parsed]
          : validateDraft(parsed, {
              format: loaded.format,
              language: loaded.language,
              needsStory: false,
              beats: [],
              leads: new Map(),
              storyClaimIds: loaded.claims.map((c) => c.ref),
            });
      if (Array.isArray(result)) errors = result;
      else draft = result;
    }
  } catch (error) {
    const known =
      error instanceof TokenCapReached ||
      error instanceof ToolLoopExceeded ||
      error instanceof ModelCallFailed ||
      (error instanceof AllModelsExhausted && !error.transient);
    if (!known) {
      // Retried: what this attempt spent still counts (D76).
      await withNewsroom(deps.pool, job.newsroomId, (c) =>
        recordUsage(c, job.agentRunId, model.meter),
      );
      throw error;
    }
    errors = [(error as Error).message];
    return fail("error", "model-error");
  }
  if (!draft) return fail("invalid", "renderer-invalid");

  // Code calls the run's one write tool with the validated rendition.
  const submit = submitTool<Draft>(async (valid) =>
    withNewsroom(deps.pool, job.newsroomId, async (client) => {
      const id = await submitRendition(client, deps.boss, {
        runId: job.agentRunId,
        meter: model.meter,
        promptVersion: prompt.version,
        assignmentId: loaded.assignmentId,
        storyId: loaded.storyId,
        format: loaded.format,
        rendition: valid.rendition,
      });
      await noticeBudget(client, await budgetState(client));
      return id ?? "";
    }),
  );
  return String(await submit.invoke({ draft })) ? "submitted" : null;

  async function fail(outcome: "invalid" | "error", name: string) {
    return withNewsroom(deps.pool, job.newsroomId, async (client) => {
      const detail = { errors };
      if (
        !(await finishRun(client, job.agentRunId, outcome, model.meter, {
          detail,
          promptVersion: prompt.version,
        }))
      ) {
        return null;
      }
      await holdLanguage(client, loaded as RendererInput, { name, result: "fail", detail });
      // The story's other languages go on to the gate.
      await gateWhenRendered(client, deps.boss, (loaded as RendererInput).storyId);
      return outcome;
    });
  }
}

/** Holds the publication of the run's language only. */
async function holdLanguage(
  client: Parameters<typeof holdPublications>[0],
  run: Pick<RendererInput, "assignmentId" | "language">,
  reason: { name: string; result: "fail" | "error"; detail: unknown },
) {
  const { rows } = await client.query<{ id: string }>(
    "select id from publications where assignment_id = $1 and language = $2",
    [run.assignmentId, run.language],
  );
  await holdPublications(
    client,
    rows.map((r) => r.id),
    reason,
  );
}
