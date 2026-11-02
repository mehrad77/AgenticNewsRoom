// Pins the names of the LLM spans and their attributes (D138): Grafana's dashboards and anyone's
// LLM tooling read them, and the GenAI conventions are still incubating. No prompt, answer or tool
// argument may reach an attribute.

import { buildCatalog, inAgent, ModelGateway, type ModelsConfig, tracedNode } from "@anr/models";
import { recordTelemetry } from "@anr/telemetry/testing";
import { AIMessage, SystemMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { converse } from "./converse.ts";
import { meteredModel } from "./model.ts";

const telemetry = recordTelemetry();

const SECRET = "UNPUBLISHED-DRAFT-TEXT";
const config: ModelsConfig = {
  providers: {
    gemini: { kind: "openai", base_url: "https://g.test/v1", key_env: "G_KEY" },
    groq: { kind: "openai", base_url: "https://q.test/v1", key_env: "Q_KEY" },
  },
  models: {
    flash: { provider: "gemini", model: "gemini-flash", family: "gemini", tools: true },
    llama: {
      provider: "groq",
      model: "llama-big",
      family: "llama",
      tools: true,
      price: { in: 1, out: 2 },
    },
  },
  roles: {
    planner: ["flash"],
    desk: { default: ["flash", "llama"] },
    renderer: ["flash"],
    "fact-checker": ["llama"],
    "item-matcher": ["flash"],
    summariser: ["flash"],
  },
  tts: "flash",
};

function gateway() {
  let llamaCalls = 0;
  return new ModelGateway(buildCatalog(config, { G_KEY: "g", Q_KEY: "q" }), {
    log: () => {},
    client: (entry) => ({
      async invoke() {
        if (entry.id === "flash")
          throw Object.assign(new Error("429"), { status: 429, headers: new Headers() });
        llamaCalls += 1;
        const usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120 };
        return llamaCalls === 1
          ? new AIMessage({
              content: "",
              tool_calls: [{ id: "call-1", name: "read_lead", args: { lead_id: SECRET } }],
              usage_metadata: usage,
            })
          : new AIMessage({ content: `answer: ${SECRET}`, usage_metadata: usage });
      },
    }),
  });
}

const readLead = tool(async () => `lead text ${SECRET}`, {
  name: "read_lead",
  description: "read",
  schema: z.object({ lead_id: z.string() }),
});

describe("LLM spans (D138)", () => {
  it("records invoke_agent, node, chat and execute_tool spans with the pinned attributes", async () => {
    const model = meteredModel(gateway(), ["flash", "llama"]);
    await inAgent("desk", "run-1", () =>
      tracedNode("desk", "outline", () =>
        converse(model, [new SystemMessage(`system ${SECRET}`)], `ask ${SECRET}`, [readLead]),
      )({}),
    );

    const spans = telemetry.spans();
    const byName = (name: string) => spans.filter((s) => s.name === name);
    const [agent] = byName("invoke_agent desk");
    const [node] = byName("desk.outline");
    // The first call falls back to llama; the run then stays on it (sticky), so the second call
    // is requested of llama-big.
    const chats = [...byName("chat gemini-flash"), ...byName("chat llama-big")];
    const [toolCall] = byName("execute_tool read_lead");

    expect(Object.keys(agent?.attributes ?? {}).sort()).toEqual([
      "anr.agent_run.id",
      "gen_ai.agent.name",
      "gen_ai.operation.name",
    ]);
    expect(Object.keys(node?.attributes ?? {})).toEqual(["anr.graph.node"]);
    expect(chats).toHaveLength(2);
    expect(Object.keys(chats[0]?.attributes ?? {}).sort()).toEqual([
      "anr.cost_usd",
      "anr.model.attempts",
      "anr.model.chain",
      "gen_ai.agent.name",
      "gen_ai.operation.name",
      "gen_ai.provider.name",
      "gen_ai.request.model",
      "gen_ai.response.model",
      "gen_ai.usage.input_tokens",
      "gen_ai.usage.output_tokens",
    ]);
    expect(chats[0]?.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "gemini-flash",
      "gen_ai.provider.name": "groq",
      "gen_ai.response.model": "llama-big",
      "gen_ai.usage.input_tokens": 100,
      "anr.model.chain": ["flash", "llama"],
      "anr.model.attempts": ["flash: rate-limited", "llama: ok"],
      "gen_ai.agent.name": "desk",
    });
    expect(chats[1]?.attributes["anr.model.attempts"]).toEqual(["llama: ok"]);
    expect(Object.keys(toolCall?.attributes ?? {}).sort()).toEqual([
      "gen_ai.agent.name",
      "gen_ai.operation.name",
      "gen_ai.tool.call.id",
      "gen_ai.tool.name",
      "gen_ai.tool.type",
    ]);

    // One run: agent → node → model calls and tool calls.
    expect(node?.parentSpanContext?.spanId).toBe(agent?.spanContext().spanId);
    for (const child of [...chats, toolCall])
      expect(child?.parentSpanContext?.spanId).toBe(node?.spanContext().spanId);
    // No content anywhere: not in an attribute, an event or a span name.
    expect(JSON.stringify(spans.map((s) => [s.name, s.attributes, s.events]))).not.toContain(
      SECRET,
    );

    const metrics = await telemetry.metrics();
    for (const name of [
      "gen_ai.client.operation.duration",
      "gen_ai.client.token.usage",
      "anr.gen_ai.cost",
      "anr.gen_ai.fallbacks",
      "anr.agent.runs",
    ])
      expect(metrics.has(name), name).toBe(true);
  });
});
