// The summariser graph: summarise → validate, with one retry carrying the errors. It never
// writes; the caller stores a valid result (summary and beats) as the run's submit.
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage, HumanMessage } from "@langchain/core/messages";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";
import {
  retryPrompt,
  type SummariserBeat,
  type SummariserLead,
  summariserPrompt,
} from "./prompt.ts";

export const MAX_ATTEMPTS = 2;

export interface SummariserResult {
  summary: string;
  beats: string[];
}

const State = Annotation.Root({
  messages: Annotation<BaseMessage[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  attempts: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  errors: Annotation<string[]>({ reducer: (_a, b) => b, default: () => [] }),
  result: Annotation<SummariserResult | null>({ reducer: (_a, b) => b, default: () => null }),
  tokensIn: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  tokensOut: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
});

/** The model's answer, checked by code: the summary's shape, and beats only from the list. */
export function parseAnswer(
  text: string,
  beatSlugs: readonly string[],
): SummariserResult | string[] {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!json) return ["no JSON object in the answer"];
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return ["the JSON does not parse"];
  }
  const shape = z
    .object({
      summary: z.string().trim().min(1).max(400),
      beats: z.array(z.string()).max(beatSlugs.length),
    })
    .safeParse(value);
  if (!shape.success)
    return shape.error.issues.map((i) => `${i.path.join(".") || "answer"}: ${i.message}`);
  const unknown = shape.data.beats.filter((b) => !beatSlugs.includes(b));
  if (unknown.length > 0)
    return [`unknown beats ${unknown.join(", ")}; use only ${beatSlugs.join(", ")}`];
  return { summary: shape.data.summary, beats: [...new Set(shape.data.beats)] };
}

function text(message: BaseMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  return content
    .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
    .join("");
}

/** Awaited before every model call, e.g. a throttle. */
export type BeforeCall = () => Promise<void>;

export function summariserGraph(
  model: BaseChatModel,
  beats: SummariserBeat[],
  beforeCall: BeforeCall = async () => {},
) {
  const slugs = beats.map((b) => b.slug);
  return new StateGraph(State)
    .addNode("summarise", async (state) => {
      const ask = state.attempts === 0 ? [] : [new HumanMessage(retryPrompt(state.errors))];
      await beforeCall();
      const reply = await model.invoke([...state.messages, ...ask]);
      const usage = reply instanceof AIMessage ? reply.usage_metadata : undefined;
      return {
        messages: [...ask, reply],
        attempts: state.attempts + 1,
        tokensIn: usage?.input_tokens ?? 0,
        tokensOut: usage?.output_tokens ?? 0,
      };
    })
    .addNode("validate", async (state) => {
      const last = state.messages.at(-1);
      const parsed = last ? parseAnswer(text(last), slugs) : ["no answer"];
      return Array.isArray(parsed) ? { errors: parsed } : { errors: [], result: parsed };
    })
    .addEdge(START, "summarise")
    .addEdge("summarise", "validate")
    .addConditionalEdges("validate", (state) =>
      state.result || state.attempts >= MAX_ATTEMPTS ? END : "summarise",
    )
    .compile();
}

export interface SummariserOutcome {
  result: SummariserResult | null;
  errors: string[];
  tokensIn: number;
  tokensOut: number;
}

export async function summarise(
  model: BaseChatModel,
  lead: SummariserLead,
  beats: SummariserBeat[],
  beforeCall?: BeforeCall,
): Promise<SummariserOutcome> {
  const final = await summariserGraph(model, beats, beforeCall).invoke({
    messages: [new HumanMessage(summariserPrompt(lead, beats))],
  });
  return {
    result: final.result,
    errors: final.errors,
    tokensIn: final.tokensIn,
    tokensOut: final.tokensOut,
  };
}
