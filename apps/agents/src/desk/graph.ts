// The desk graph (D77): read → outline → draft → claims → validate, one retry of the claims step
// with the errors, then the run ends with a valid draft or none. It never writes: the run calls
// the submit tool with a valid draft, or holds the assignment.
import { type BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { converse, textOf } from "../converse.ts";
import type { ChatLike } from "../model.ts";
import { DESK_CLAIMS, DESK_DRAFT, DESK_OUTLINE, retryPrompt } from "../prompts/roles.ts";
import type { LeadText } from "../tools/leads.ts";
import { type Draft, parseJson, type ValidationContext, validateDraft } from "./validate.ts";

/** One answer plus one retry with the errors; then the assignment is held (technical design). */
export const MAX_SUBMITS = 2;
/**
 * Stored text shown per assignment lead up front, next to its summary; the model reads the rest
 * with read_lead. Every model call resends the conversation, so this is paid once per call.
 */
export const EXCERPT_CHARS = 1_500;

export interface Assignment {
  angle: string | null;
  series: string;
  format: string;
  language: string;
  /** Item counts from the series, such as {news: "5-8", articles: "0-2"}. */
  items: Record<string, string>;
  beats: { slug: string; status: string; description: string | null }[];
  leads: LeadText[];
}

const State = Annotation.Root({
  messages: Annotation<BaseMessage[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  attempts: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  errors: Annotation<string[]>({ reducer: (_a, b) => b, default: () => [] }),
  // Not `draft`: node names and state keys share one namespace in LangGraph.
  result: Annotation<Draft | null>({ reducer: (_a, b) => b, default: () => null }),
});

/** The read step: the assignment and its leads, as the first message of the run. */
export function assignmentMessage(a: Assignment): string {
  const beats = a.beats
    .filter((b) => b.status !== "banned")
    .map(
      (b) =>
        `- ${b.slug}${b.status === "restricted" ? " (restricted)" : ""}: ${b.description ?? ""}`,
    )
    .join("\n");
  const leads = a.leads
    .map((l) => {
      const text =
        l.text.length > EXCERPT_CHARS
          ? `${l.text.slice(0, EXCERPT_CHARS)}\n[… read_lead for the rest]`
          : l.text;
      return [
        `## Lead ${l.id}`,
        `Headline: ${l.headline ?? "(none)"} | Publisher: ${l.publisher} | Tier: ${l.tier} | Date: ${l.published ?? "unknown"} | Language: ${l.language}`,
        l.withdrawn ? `WITHDRAWN: ${l.withdrawn}. Do not cite.` : "",
        l.summary ? `Summary: ${l.summary}` : "",
        text,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
  const counts = Object.entries(a.items)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  return `Assignment: series ${a.series}, format ${a.format}, language ${a.language}${counts ? `, items: ${counts}` : ""}.
${a.angle ? `Angle: ${a.angle}\n` : ""}
Beats (choose one for the story):
${beats}

Leads (most credible first):

${leads}`;
}

export interface DeskGraphDeps {
  model: ChatLike;
  tools: readonly StructuredToolInterface[];
  /** Built when validating, so leads read during the run are citable. */
  validation: () => ValidationContext;
  language: string;
}

export function deskGraph(deps: DeskGraphDeps) {
  const turn = (ask: string) => async (state: typeof State.State) => ({
    messages: await converse(deps.model, state.messages, ask, deps.tools),
  });
  return new StateGraph(State)
    .addNode("outline", turn(DESK_OUTLINE))
    .addNode("draft", turn(DESK_DRAFT(deps.language)))
    .addNode("claims", async (state) => ({
      messages: await converse(
        deps.model,
        state.messages,
        state.attempts === 0 ? DESK_CLAIMS : retryPrompt(state.errors),
        deps.tools,
      ),
      attempts: state.attempts + 1,
    }))
    .addNode("validate", async (state) => {
      const parsed = parseJson(textOf(state.messages.at(-1)));
      if (typeof parsed === "string") return { errors: [parsed] };
      const result = validateDraft(parsed, deps.validation());
      return Array.isArray(result) ? { errors: result } : { errors: [], result };
    })
    .addEdge(START, "outline")
    .addEdge("outline", "draft")
    .addEdge("draft", "claims")
    .addEdge("claims", "validate")
    .addConditionalEdges("validate", (s) =>
      s.result || s.attempts >= MAX_SUBMITS ? END : "claims",
    )
    .compile();
}

export interface DeskOutcome {
  draft: Draft | null;
  errors: string[];
}

export async function writeDraft(
  deps: DeskGraphDeps,
  system: string,
  assignment: Assignment,
): Promise<DeskOutcome> {
  const final = await deskGraph(deps).invoke(
    {
      messages: [new SystemMessage(system), new HumanMessage(assignmentMessage(assignment))],
    },
    // Tool rounds happen inside a step; the graph itself has at most six steps.
    { recursionLimit: 12 },
  );
  return { draft: final.result, errors: final.errors };
}
