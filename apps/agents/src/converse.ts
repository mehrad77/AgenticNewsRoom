// One turn of a run's conversation: ask, let the model call its research tools a bounded number of
// times, return every message of the turn. A tool name outside the bound list gets an error answer;
// nothing else can run (invariant 2).
import { AIMessage, type BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { ChatLike } from "./model.ts";

/** Tool rounds per turn; then the model is told to answer with what it has. */
export const MAX_TOOL_ROUNDS = 6;

export function textOf(message: BaseMessage | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!content) return "";
  return content
    .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
    .join("");
}

export async function converse(
  model: ChatLike,
  history: readonly BaseMessage[],
  ask: string,
  tools: readonly StructuredToolInterface[] = [],
): Promise<BaseMessage[]> {
  const turn: BaseMessage[] = [new HumanMessage(ask)];
  const options = tools.length > 0 ? { tools: [...tools] } : undefined;
  for (let round = 0; ; round++) {
    const reply = await model.invoke([...history, ...turn], options);
    turn.push(reply);
    const calls = reply instanceof AIMessage ? (reply.tool_calls ?? []) : [];
    if (calls.length === 0) return turn;
    for (const call of calls) {
      const found = tools.find((t) => t.name === call.name);
      let content: string;
      if (!found || round >= MAX_TOOL_ROUNDS) {
        content = JSON.stringify({
          error: found
            ? "no more tool calls in this step; answer now"
            : `no tool named ${call.name}`,
        });
      } else {
        try {
          content = String(await found.invoke(call.args));
        } catch (error) {
          content = JSON.stringify({ error: (error as Error).message });
        }
      }
      turn.push(new ToolMessage({ content, tool_call_id: call.id ?? call.name, name: call.name }));
    }
    if (round > MAX_TOOL_ROUNDS)
      throw new Error("the model kept calling tools after it was told to answer");
  }
}
