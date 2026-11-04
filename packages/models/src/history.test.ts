import {
  AIMessage,
  type BaseMessageLike,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { afterEach, describe, expect, it, vi } from "vitest";
import { langchainClient } from "./adapters.ts";
import { buildCatalog, type CatalogEntry, type ModelsConfig } from "./catalog.ts";
import { ModelGateway } from "./gateway.ts";

const config: ModelsConfig = {
  providers: {
    anthropic: { kind: "anthropic", key_env: "A_KEY" },
    other: { kind: "openai", base_url: "https://other.test/v1", key_env: "O_KEY" },
  },
  models: {
    claude: { provider: "anthropic", model: "claude-opus-5-5", family: "claude", tools: true },
    other: { provider: "other", model: "big", family: "big", tools: true },
  },
  roles: {
    planner: ["claude"],
    desk: { default: ["claude"] },
    renderer: ["claude"],
    "fact-checker": ["claude", "other"],
    "item-matcher": ["claude"],
    summariser: ["claude"],
  },
  tts: "claude",
};
const catalog = buildCatalog(config, { A_KEY: "a", O_KEY: "o" });

/** What Claude answered earlier in the run: thinking, text and a tool call. */
const fromClaude = () =>
  new AIMessage({
    id: "msg_1",
    content: [
      { type: "thinking", thinking: "Check the lead first.", signature: "sig" },
      { type: "redacted_thinking", data: "opaque" },
      { type: "text", text: "Reading the lead." },
      { type: "tool_use", id: "toolu_1", name: "read_lead", input: { id: "l1" } },
    ],
    tool_calls: [{ id: "toolu_1", name: "read_lead", args: { id: "l1" }, type: "tool_call" }],
    usage_metadata: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
  });
const history = (): BaseMessageLike[] => [
  new HumanMessage("Write it up."),
  fromClaude(),
  new ToolMessage({ tool_call_id: "toolu_1", content: "the lead" }),
];

/** A gateway whose models record the messages they were sent; Claude is out of credit. */
function setup() {
  const sent = new Map<string, BaseMessageLike[]>();
  const gateway = new ModelGateway(catalog, {
    log: () => {},
    client: (entry: CatalogEntry) => ({
      async invoke(messages) {
        sent.set(entry.id, messages);
        if (entry.id === "claude") {
          throw Object.assign(new Error("400 Your credit balance is too low"), { status: 400 });
        }
        return new AIMessage("done");
      },
    }),
  });
  return { gateway, sent };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("history on a fallback", () => {
  it("strips Claude's thinking for a non-Anthropic model and keeps the rest", async () => {
    const { gateway, sent } = setup();
    const messages = history();
    const res = await gateway.chat({ chain: ["claude", "other"], messages });
    expect(res.catalogId).toBe("other");
    expect(sent.get("claude")).toBe(messages);
    const ai = sent.get("other")?.[1] as AIMessage;
    expect(ai.content).toEqual([
      { type: "text", text: "Reading the lead." },
      { type: "tool_use", id: "toolu_1", name: "read_lead", input: { id: "l1" } },
    ]);
    expect(ai.tool_calls).toEqual(fromClaude().tool_calls);
    expect(ai.id).toBe("msg_1");
    expect(ai.usage_metadata).toEqual(fromClaude().usage_metadata);
    expect(sent.get("other")?.[0]).toBe(messages[0]);
    expect(sent.get("other")?.[2]).toBe(messages[2]);
    // The caller's history is not changed.
    expect((messages[1] as AIMessage).content).toHaveLength(4);
  });

  it("sends an OpenAI-compatible provider the text and tool call, without thinking", async () => {
    const bodies: { messages: Record<string, unknown>[] }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({
          id: "c1",
          object: "chat.completion",
          created: 0,
          model: "big",
          choices: [
            { index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" },
          ],
        });
      }),
    );
    const gateway = new ModelGateway(catalog, { log: () => {}, client: langchainClient });
    await gateway.chat({ chain: ["other"], messages: history() });
    const sent = JSON.stringify(bodies[0]?.messages);
    expect(sent).not.toMatch(/thinking|sig|opaque/);
    expect(bodies[0]?.messages[1]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "toolu_1", function: { name: "read_lead" } }],
    });
    expect(sent).toContain("Reading the lead.");
  });
});
