import { AIMessage, type BaseMessageLike } from "@langchain/core/messages";
import type { CatalogEntry } from "./catalog.ts";

const THINKING = new Set(["thinking", "redacted_thinking"]);

/**
 * The history as the next model should see it. A run that fell back from Claude carries its
 * thinking blocks; Anthropic drops blocks it cannot read itself, but other providers may reject
 * or misread them, so they are removed. Text, tool calls and everything else stay as they are.
 */
export function historyFor(
  kind: CatalogEntry["kind"],
  messages: BaseMessageLike[],
): BaseMessageLike[] {
  if (kind === "anthropic") return messages;
  return messages.map((m) => {
    if (!AIMessage.isInstance(m) || !Array.isArray(m.content)) return m;
    const content = m.content.filter((block) => !THINKING.has(block.type));
    if (content.length === m.content.length) return m;
    return new AIMessage({
      content,
      id: m.id,
      name: m.name,
      tool_calls: m.tool_calls,
      invalid_tool_calls: m.invalid_tool_calls,
      additional_kwargs: m.additional_kwargs,
      response_metadata: m.response_metadata,
      usage_metadata: m.usage_metadata,
    });
  });
}
