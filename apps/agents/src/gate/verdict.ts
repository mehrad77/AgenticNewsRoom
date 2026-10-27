// The fact-checker's and item matcher's graph: one question with a fresh context, the model's
// verdict parsed by code, one retry when it does not parse, else an error. The checker never sees
// the draft or the writer's reasoning, only what one check needs (technical design, D80).
import { type BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";
import { textOf } from "../converse.ts";
import { parseJson } from "../desk/validate.ts";
import type { ChatLike } from "../model.ts";
import { FACT_CHECKER_ROLE, ITEM_MATCHER_ROLE, retryPrompt } from "../prompts/roles.ts";

export type CheckVerdict = { result: "pass" | "partial" | "fail"; reason: string };
type Parse = (value: unknown) => CheckVerdict | string;

const State = Annotation.Root({
  messages: Annotation<BaseMessage[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  attempts: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  error: Annotation<string>({ reducer: (_a, b) => b, default: () => "" }),
  verdict: Annotation<CheckVerdict | null>({ reducer: (_a, b) => b, default: () => null }),
});

export function verdictGraph(model: ChatLike, parse: Parse) {
  return new StateGraph(State)
    .addNode("ask", async (state) => {
      const retry = state.attempts === 0 ? [] : [new HumanMessage(retryPrompt([state.error]))];
      const reply = await model.invoke([...state.messages, ...retry]);
      return { messages: [...retry, reply], attempts: state.attempts + 1 };
    })
    .addNode("parse", async (state) => {
      const value = parseJson(textOf(state.messages.at(-1)));
      const parsed = typeof value === "string" ? value : parse(value);
      return typeof parsed === "string" ? { error: parsed } : { verdict: parsed, error: "" };
    })
    .addEdge(START, "ask")
    .addEdge("ask", "parse")
    .addConditionalEdges("parse", (s) => (s.verdict || s.attempts >= 2 ? END : "ask"))
    .compile();
}

/** A verdict, or the reason there is none (a check that errors holds, invariant 5). */
export async function askVerdict(
  model: ChatLike,
  system: string,
  question: string,
  parse: Parse,
): Promise<CheckVerdict | { error: string }> {
  const final = await verdictGraph(model, parse).invoke({
    messages: [new SystemMessage(system), new HumanMessage(question)],
  });
  return final.verdict ?? { error: final.error || "no verdict" };
}

const FactAnswer = z.object({
  verdict: z.enum(["supported", "partial", "unsupported"]),
  reason: z.string().default(""),
});

export const parseFact: Parse = (value) => {
  const a = FactAnswer.safeParse(value);
  if (!a.success)
    return 'answer {"verdict": "supported" | "partial" | "unsupported", "reason": "..."}';
  const result = { supported: "pass", partial: "partial", unsupported: "fail" } as const;
  return { result: result[a.data.verdict], reason: a.data.reason };
};

const ItemAnswer = z.object({
  verdict: z.enum(["match", "beyond"]),
  beyond: z.string().default(""),
});

export const parseItem: Parse = (value) => {
  const a = ItemAnswer.safeParse(value);
  if (!a.success) return 'answer {"verdict": "match" | "beyond", "beyond": "..."}';
  return { result: a.data.verdict === "match" ? "pass" : "fail", reason: a.data.beyond };
};

/** Fact-checks one claim against one passage: nothing else is in its context. */
export const factQuestion = (claim: string, passage: string) =>
  `Claim:\n${claim}\n\nPassage from the stored source:\n${passage}`;

export const itemQuestion = (item: string, claims: readonly string[]) =>
  `Item:\n${item}\n\nIts claims:\n${claims.map((c) => `- ${c}`).join("\n")}`;

export { FACT_CHECKER_ROLE, ITEM_MATCHER_ROLE };
