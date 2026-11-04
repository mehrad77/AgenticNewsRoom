import { ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { langchainClient, MAX_OUTPUT_TOKENS } from "./adapters.ts";
import type { CatalogEntry } from "./catalog.ts";
import { classify } from "./errors.ts";

const claude = (model: string): CatalogEntry => ({
  id: model,
  provider: "anthropic",
  kind: "anthropic",
  model,
  family: model,
  tools: true,
  apiKey: "sk-test",
  missingEnv: [],
  sharedQuota: false,
  timeoutMs: 10_000,
});

const PING = {
  type: "function" as const,
  function: {
    name: "ping",
    description: "Answer by calling this tool.",
    parameters: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
  },
};
// The shape the agents pass: LangChain tools.
const readLead = tool(async () => "", {
  name: "read_lead",
  description: "Read a lead.",
  schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
});

/** A Messages API answer: Opus 5.5 thinks, then calls the tool. */
const answer = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [
    { type: "thinking", thinking: "The user wants a ping.", signature: "sig-abc" },
    { type: "tool_use", id: "toolu_1", name: "ping", input: { ok: true } },
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 34 },
};

/** Stubs fetch with one response and records the request bodies the SDK sends. */
function stubFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const bodies: Record<string, unknown>[] = [];
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      });
    }),
  );
  return { bodies, urls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Anthropic adapter", () => {
  it.each(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"])(
    "%s: no sampling or thinking parameters, only the given tools, auto for any",
    async (model) => {
      const { bodies, urls } = stubFetch(200, { ...answer, model });
      await langchainClient(claude(model)).invoke([["human", "ping"]], {
        tools: [PING, readLead],
        toolChoice: "any",
      });
      expect(urls).toEqual(["https://api.anthropic.com/v1/messages"]);
      const body = bodies[0] ?? {};
      for (const key of ["temperature", "top_p", "top_k", "thinking", "mcp_servers", "container"]) {
        expect(body).not.toHaveProperty(key);
      }
      expect(body.model).toBe(model);
      expect(body.max_tokens).toBe(MAX_OUTPUT_TOKENS);
      expect(body.tool_choice).toEqual({ type: "auto" });
      const tools = body.tools as Record<string, unknown>[];
      expect(tools.map((t) => t.name)).toEqual(["ping", "read_lead"]);
      for (const t of tools) {
        expect(t).not.toHaveProperty("type");
        expect(t.input_schema).toMatchObject({ type: "object" });
      }
    },
  );

  it("sends no tools or tool choice when none are given", async () => {
    const { bodies } = stubFetch(200, {
      ...answer,
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
    });
    const message = await langchainClient(claude("claude-haiku-5-5")).invoke([["human", "hi"]], {});
    expect(bodies[0]).not.toHaveProperty("tools");
    expect(bodies[0]).not.toHaveProperty("tool_choice");
    expect(bodies[0]).not.toHaveProperty("temperature");
    expect(message.content).toBe("hi");
  });

  it("returns the message with its thinking block, so the tool loop can send it back", async () => {
    stubFetch(200, answer);
    const message = await langchainClient(claude("claude-opus-5-5")).invoke([["human", "ping"]], {
      tools: [PING],
    });
    expect(message.content).toEqual([
      { type: "thinking", thinking: "The user wants a ping.", signature: "sig-abc" },
      expect.objectContaining({ type: "tool_use", id: "toolu_1", name: "ping" }),
    ]);
    expect(message.tool_calls).toEqual([
      expect.objectContaining({ id: "toolu_1", name: "ping", args: { ok: true } }),
    ]);
    expect(message.usage_metadata).toMatchObject({ input_tokens: 12, output_tokens: 34 });
  });

  it("sends the thinking block back, signed, with the tool result", async () => {
    const { bodies } = stubFetch(200, answer);
    const client = langchainClient(claude("claude-opus-5-5"));
    const first = await client.invoke([["human", "ping"]], { tools: [PING] });
    await client.invoke(
      [["human", "ping"], first, new ToolMessage({ tool_call_id: "toolu_1", content: "pong" })],
      { tools: [PING] },
    );
    const sent = (bodies[1]?.messages ?? []) as { role: string; content: unknown[] }[];
    expect(sent[1]?.role).toBe("assistant");
    expect(sent[1]?.content).toEqual([
      { type: "thinking", thinking: "The user wants a ping.", signature: "sig-abc" },
      expect.objectContaining({
        type: "tool_use",
        id: "toolu_1",
        name: "ping",
        input: { ok: true },
      }),
    ]);
    expect(sent[2]).toMatchObject({
      role: "user",
      content: [expect.objectContaining({ type: "tool_result", tool_use_id: "toolu_1" })],
    });
  });

  it.each([
    [
      429,
      "rate_limit_error",
      "Number of request tokens has exceeded your rate limit",
      "rate-limited",
    ],
    [529, "overloaded_error", "Overloaded", "unavailable"],
    [500, "api_error", "Internal server error", "unavailable"],
    [413, "request_too_large", "Request exceeds the maximum allowed number of bytes.", "too-large"],
    [
      400,
      "invalid_request_error",
      "prompt is too long: 250123 tokens > 200000 maximum",
      "too-large",
    ],
    [
      400,
      "invalid_request_error",
      "Your credit balance is too low to access the API.",
      "rate-limited",
    ],
    [400, "invalid_request_error", "messages: at least one message is required", "fatal"],
    [401, "authentication_error", "invalid x-api-key", "fatal"],
    [403, "permission_error", "Your API key does not have permission", "fatal"],
    [404, "not_found_error", "model: claude-opus-0", "gone"],
  ] as const)("classifies the SDK's %i %s: %s", async (status, type, message, kind) => {
    stubFetch(status, { type: "error", error: { type, message } }, { "retry-after": "17" });
    const error = await langchainClient(claude("claude-sonnet-5-5"))
      .invoke([["human", "hi"]], {})
      .catch((e: unknown) => e);
    const result = classify(error);
    expect(result.kind).toBe(kind);
    if (kind === "rate-limited" || kind === "unavailable") expect(result.retryAfterMs).toBe(17_000);
  });
});
