// A renderer run that writes one language of an episode script (D107): one model call per part,
// each in a short conversation of its own with one retry on errors, then the assembled script is
// validated against the format's schema and submitted. Any part that fails twice holds this
// language; the other languages go on to the gate.
import type { AgentRunJob, Language } from "@anr/core";
import { localDay } from "@anr/core";
import { type Client, withNewsroom } from "@anr/db";
import { DRAFT_SCHEMAS } from "@anr/schemas";
import { type BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { budgetState, mayStart, noticeBudget } from "../budget.ts";
import { formatMeta } from "../context.ts";
import { converse, textOf } from "../converse.ts";
import { MAX_SUBMITS } from "../desk/graph.ts";
import { type RoleDeps, runFailure } from "../desk/run.ts";
import { gateWhenRendered, submitRendition } from "../desk/submit.ts";
import { type Draft, parseJson } from "../desk/validate.ts";
import { newMeter, type RunModel } from "../model.ts";
import { assemblePrompt, readGuides } from "../prompts/assemble.ts";
import { retryPrompt } from "../prompts/roles.ts";
import { finishRun, holdPublications, recordUsage } from "../runs.ts";
import { submitTool } from "../tools/tools.ts";
import type { EpisodeTask } from "./episode.ts";
import {
  ARC,
  BEAT_STEP,
  type BeatPart,
  PLAN_STEP,
  type Plan,
  PODCAST_ROLE,
  partWords,
  TOPICS_STEP,
  type Topic,
  validateBeat,
  validatePlan,
  validateTopics,
} from "./script.ts";

const FORMAT = "podcast-episode";

interface Claim {
  ref: string;
  kind: string;
  text: string;
}
interface Source {
  storyId: string;
  /** The source story's claims by their ref in the episode story. */
  refs: Map<string, string>;
  /** Its published rendition in this language (or its first, if none), refs translated. */
  body: unknown;
}

interface Loaded {
  storyId: string;
  assignmentId: string;
  language: Language;
  newsroom: string;
  seriesName: string;
  slot: Date;
  timezone: string;
  hosts: string[];
  /** How each host is named in this language (`host_names`); the key otherwise. */
  names: Record<string, string>;
  narrator: boolean;
  task: EpisodeTask;
  claims: Claim[];
  sources: Map<string, Source>;
}

/** Whether a renderer run writes an episode script rather than another language of a story. */
export async function isEpisodeRun(client: Client, runId: string): Promise<boolean> {
  const { rows } = await client.query<{ kind: string | null }>(
    "select task->>'kind' as kind from agent_runs where id = $1",
    [runId],
  );
  return rows[0]?.kind === "episode";
}

/** Replaces a source story's claim refs with the episode story's, wherever `claim_ids` appear. */
function translate(value: unknown, refs: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((v) => translate(v, refs));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        k === "claim_ids" && Array.isArray(v)
          ? v.map((id) => refs.get(String(id))).filter(Boolean)
          : translate(v, refs),
      ]),
    );
  }
  return value;
}

async function load(client: Client, runId: string): Promise<Loaded | null> {
  const { rows } = await client.query<{
    outcome: string | null;
    task: EpisodeTask;
    story_id: string;
    assignment_id: string;
    language: Language;
    newsroom: string;
    config: {
      name?: Record<string, string>;
      hosts?: Record<string, Record<string, string>>;
      host_names?: Record<string, Record<string, string>>;
      narrator?: Record<string, string>;
    };
    slug: string;
    slot: Date;
    timezone: string;
  }>(
    `select r.outcome, r.task, r.story_id, r.assignment_id, r.language, n.slug as newsroom,
            se.config, se.slug, a.slot, n.timezone
     from agent_runs r join assignments a on a.id = r.assignment_id
     join series se on se.id = a.series_id join newsrooms n on n.id = r.newsroom_id
     where r.id = $1 and r.role = 'renderer'`,
    [runId],
  );
  const run = rows[0];
  if (!run || run.outcome !== null || run.task?.kind !== "episode") return null;
  const { rows: claims } = await client.query<Claim & { copied_from: string }>(
    "select ref, kind, text, copied_from from claims where story_id = $1 order by created_at, ref",
    [run.story_id],
  );
  const byOriginal = new Map(claims.map((c) => [c.copied_from, c.ref]));
  const sources = new Map<string, Source>();
  for (const storyId of run.task.segments.flatMap((s) => s.stories)) {
    const { rows: originals } = await client.query<{ id: string; ref: string }>(
      "select id, ref from claims where story_id = $1",
      [storyId],
    );
    const refs = new Map(
      originals.flatMap((o) => {
        const mine = byOriginal.get(o.id);
        return mine ? [[o.ref, mine] as const] : [];
      }),
    );
    const { rows: body } = await client.query<{ body: unknown }>(
      `select r.body from renditions r
       left join publication_renditions pr on pr.rendition_id = r.id
       left join publications p on p.id = pr.publication_id and p.status in ('published', 'corrected')
       where r.story_id = $1
       order by (r.language = $2 and p.id is not null) desc, (p.id is not null) desc, r.created_at
       limit 1`,
      [storyId, run.language],
    );
    sources.set(storyId, { storyId, refs, body: translate(body[0]?.body ?? {}, refs) });
  }
  return {
    storyId: run.story_id,
    assignmentId: run.assignment_id,
    language: run.language,
    newsroom: run.newsroom,
    seriesName: run.config.name?.[run.language] ?? run.slug,
    slot: run.slot,
    timezone: run.timezone,
    hosts: Object.keys(run.config.hosts?.[run.language] ?? {}),
    names: run.config.host_names?.[run.language] ?? {},
    narrator: Boolean(run.config.narrator?.[run.language]),
    task: run.task,
    claims: claims.map(({ copied_from: _, ...c }) => c),
    sources,
  };
}

/** One part: its own short conversation, one retry with the errors. */
async function part<T>(
  model: RunModel,
  system: string,
  context: string,
  ask: string,
  validate: (value: unknown) => T | string[],
): Promise<T | string[]> {
  const messages: BaseMessage[] = [new SystemMessage(system), new HumanMessage(context)];
  let errors: string[] = [];
  for (let attempt = 0; attempt < MAX_SUBMITS; attempt++) {
    const turn = await converse(model, messages, attempt === 0 ? ask : retryPrompt(errors));
    messages.push(...turn);
    const parsed = parseJson(textOf(turn.at(-1)), { closeBrackets: true });
    const result = typeof parsed === "string" ? [parsed] : validate(parsed);
    if (!Array.isArray(result) || (result.length > 0 && typeof result[0] !== "string")) {
      return result as T;
    }
    errors = result as string[];
  }
  return errors;
}

const claimLines = (claims: readonly Claim[]) =>
  claims.map((c) => `- ${c.ref} (${c.kind}): ${c.text}`).join("\n");

/** The prompt of an episode script run; every step counts toward the 5 KB (D75). */
export function episodePrompt(configDir: string, newsroom: string, language: string) {
  const { style, guide } = readGuides(configDir, newsroom, FORMAT);
  return assemblePrompt("renderer", {
    role: PODCAST_ROLE,
    steps: [TOPICS_STEP("a, b", 100), PLAN_STEP, BEAT_STEP("turning-point", "a, b, narrator", 100)],
    style,
    guide,
    language,
  });
}

export async function runEpisode(deps: RoleDeps, job: AgentRunJob): Promise<string | null> {
  const loaded = await withNewsroom(deps.pool, job.newsroomId, async (client) => {
    const l = await load(client, job.agentRunId);
    if (!l) return null;
    const budget = await budgetState(client);
    const verdict = mayStart("renderer", budget);
    if (!verdict.ok) {
      await noticeBudget(client, budget);
      await finishRun(client, job.agentRunId, "paused", newMeter(), {
        detail: { reason: verdict.reason },
      });
      await holdLanguage(client, l, {
        name: "budget",
        result: "error",
        detail: { reason: verdict.reason },
      });
      await gateWhenRendered(client, deps.boss, l.storyId);
      return null;
    }
    return l;
  });
  if (!loaded) return null;
  const l = loaded;

  const prompt = episodePrompt(deps.configDir, l.newsroom, l.language);
  const model = deps.makeModel(
    deps.router.resolve("renderer"),
    formatMeta(deps.configDir, FORMAT).run_tokens,
  );
  const speakers = [...l.hosts, ...(l.narrator ? ["narrator"] : [])];
  // Lines name their speaker by key; in the spoken text a host is called by their name.
  const named = l.hosts.map((h) => (l.names[h] ? `${h} (called "${l.names[h]}" in speech)` : h));
  const header = `Language: ${l.language}. Series: ${l.seriesName}. Hosts: ${named.join(", ")}.${l.narrator ? " Narrator: narrator." : ""}`;

  const items: unknown[] = [];
  let errors: string[] = [];
  try {
    for (const segment of l.task.segments) {
      if (segment.kind === "news-recap") {
        const topics: Topic[] = [];
        for (const storyId of segment.stories) {
          const source = l.sources.get(storyId);
          const refs = new Set(source?.refs.values() ?? []);
          const claims = l.claims.filter((c) => refs.has(c.ref));
          const context = `${header}\n\nSource story, as published:\n${JSON.stringify(source?.body)}\n\nIts claims:\n${claimLines(claims)}`;
          const result = await part(
            model,
            prompt.system,
            context,
            TOPICS_STEP(l.hosts.join(", "), partWords(segment, segment.stories.length)),
            (v) => validateTopics(v, l.hosts, refs),
          );
          if (isErrors(result)) return fail("invalid", result);
          topics.push(...result);
        }
        items.push({ segment: "news-recap", topics });
        continue;
      }
      const storyId = segment.stories[0] ?? "";
      const source = l.sources.get(storyId);
      const refs = new Set(source?.refs.values() ?? []);
      const claims = l.claims.filter((c) => refs.has(c.ref));
      const facts = new Set(claims.filter((c) => c.kind === "fact").map((c) => c.ref));
      const context = `${header}\n\nThe story, as published:\n${JSON.stringify(source?.body)}\n\nIts claims:\n${claimLines(claims)}`;
      const plan = await part<Plan>(model, prompt.system, context, PLAN_STEP, (v) =>
        validatePlan(v, facts),
      );
      if (isErrors(plan)) return fail("invalid", plan);
      const beats: BeatPart[] = [];
      for (const beat of ARC) {
        const sofar = beats
          .map(
            (b) =>
              `[${b.beat}] ${b.lines.map((ln) => ("text" in ln ? `${ln.speaker}: ${ln.text}` : `(${ln.cue})`)).join(" ")}`,
          )
          .join("\n");
        const ask = BEAT_STEP(beat, speakers.join(", "), partWords(segment, ARC.length));
        const result = await part(
          model,
          prompt.system,
          `${context}\n\nPlan: ${JSON.stringify(plan)}${sofar ? `\n\nBeats so far:\n${sofar}` : ""}`,
          ask,
          (v) => validateBeat(v, beat, speakers, refs),
        );
        if (isErrors(result)) return fail("invalid", result);
        beats.push(result);
      }
      items.push({ segment: "story", title: plan.title, protagonists: plan.protagonists, beats });
    }
  } catch (error) {
    const failure = runFailure(error);
    if (!failure) {
      await withNewsroom(deps.pool, job.newsroomId, (c) =>
        recordUsage(c, job.agentRunId, model.meter),
      );
      throw error;
    }
    return fail("error", [failure.message]);
  }

  const rendition = {
    language: l.language,
    title: `${l.seriesName} · ${localDay(l.slot, l.timezone)}`,
    items,
  };
  const checked = DRAFT_SCHEMAS[FORMAT]?.safeParse({ rendition });
  if (!checked?.success) {
    return fail(
      "invalid",
      checked?.error.issues.slice(0, 20).map((i) => `${i.path.join(".")}: ${i.message}`) ?? [
        "no schema",
      ],
    );
  }

  // Code calls the run's one write tool with the validated script.
  const submit = submitTool<Draft>(async (valid) =>
    withNewsroom(deps.pool, job.newsroomId, async (client) => {
      const id = await submitRendition(client, deps.boss, {
        runId: job.agentRunId,
        meter: model.meter,
        promptVersion: prompt.version,
        assignmentId: l.assignmentId,
        storyId: l.storyId,
        format: FORMAT,
        rendition: valid.rendition,
      });
      await noticeBudget(client, await budgetState(client));
      return id ?? "";
    }),
  );
  try {
    return String(await submit.invoke({ draft: { rendition } as unknown as Draft }))
      ? "submitted"
      : null;
  } catch (error) {
    await withNewsroom(deps.pool, job.newsroomId, (c) =>
      recordUsage(c, job.agentRunId, model.meter),
    );
    throw error;
  }

  function isErrors<T>(r: T | string[]): r is string[] {
    return Array.isArray(r) && (r.length === 0 || typeof r[0] === "string");
  }

  async function fail(outcome: "invalid" | "error", why: string[]) {
    errors = why;
    return withNewsroom(deps.pool, job.newsroomId, async (client) => {
      const detail = { errors };
      if (
        !(await finishRun(client, job.agentRunId, outcome, model.meter, {
          detail,
          promptVersion: prompt.version,
        }))
      )
        return null;
      await holdLanguage(client, l, {
        name: outcome === "error" ? "model-error" : "renderer-invalid",
        result: outcome === "error" ? "error" : "fail",
        detail,
      });
      await gateWhenRendered(client, deps.boss, l.storyId);
      return outcome;
    });
  }
}

async function holdLanguage(
  client: Client,
  l: Pick<Loaded, "assignmentId" | "language">,
  reason: { name: string; result: "fail" | "error"; detail: unknown },
) {
  const { rows } = await client.query<{ id: string }>(
    "select id from publications where assignment_id = $1 and language = $2",
    [l.assignmentId, l.language],
  );
  await holdPublications(
    client,
    rows.map((r) => r.id),
    reason,
  );
}
