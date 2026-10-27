import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import type { ChatClient, InvokeOptions } from "./adapters.ts";
import { buildCatalog, type ModelsConfig } from "./catalog.ts";
import { AllModelsExhausted, ModelCallFailed } from "./errors.ts";
import { ModelGateway } from "./gateway.ts";

const config: ModelsConfig = {
  providers: {
    a: { kind: "openai", base_url: "https://a.test/v1", key_env: "A_KEY", limits: { rpd: 3 } },
    b: { kind: "openai", base_url: "https://b.test/v1", key_env: "B_KEY", shared_quota: true },
    c: {
      kind: "openai",
      base_url: "https://c.test/{account}/v1",
      key_env: "C_KEY",
      account_env: "C_ACCOUNT",
    },
  },
  models: {
    "a-big": { provider: "a", model: "big", family: "big", tools: true, limits: { rpm: 2 } },
    "a-small": { provider: "a", model: "small", family: "small", tools: true },
    "b-big": {
      provider: "b",
      model: "vendor/big",
      family: "big",
      tools: true,
      price: { in: 2, out: 10 },
    },
    "b-small": { provider: "b", model: "vendor/small", family: "small", tools: true },
    "c-big": { provider: "c", model: "big", family: "big", tools: true },
  },
  roles: {
    planner: ["a-big"],
    desk: { default: ["a-big"] },
    renderer: ["a-big"],
    "fact-checker": ["a-big", "a-small"],
    "item-matcher": ["a-big"],
    summariser: ["a-big"],
  },
  tts: "a-big",
};
const env = { A_KEY: "ka", B_KEY: "kb" };
const chain = ["a-big", "b-big"];
const messages = [["human", "hi"] as ["human", string]];

const httpError = (status: number, headers: Record<string, string> = {}, message = `${status}`) =>
  Object.assign(new Error(message), { status, headers: new Headers(headers) });

/** A gateway whose models answer from per-model scripts: an Error is thrown, anything else answers. */
function setup(script: Record<string, (Error | "ok")[]>) {
  let now = Date.parse("2026-10-27T12:00:00Z");
  const calls: string[] = [];
  const logs: string[] = [];
  const options: InvokeOptions[] = [];
  const client = (id: string): ChatClient => ({
    async invoke(_messages, opts) {
      calls.push(id);
      options.push(opts);
      const next = script[id]?.shift() ?? "ok";
      if (next instanceof Error) throw next;
      return new AIMessage({
        content: `from ${id}`,
        usage_metadata: { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 },
      });
    },
  });
  const gateway = new ModelGateway(buildCatalog(config, env), {
    client: (entry) => client(entry.id),
    now: () => now,
    log: (line) => logs.push(line),
  });
  return { gateway, calls, logs, options, advance: (ms: number) => (now += ms) };
}

describe("ModelGateway", () => {
  it("answers from the first model and reports which one", async () => {
    const { gateway } = setup({});
    const res = await gateway.chat({ chain, messages });
    expect(res).toMatchObject({ catalogId: "a-big", provider: "a", model: "big", family: "big" });
    expect(res.usage).toEqual({ input: 1000, output: 500 });
    expect(res.costUsd).toBeNull();
  });

  it("computes cost from the catalog price", async () => {
    const { gateway } = setup({});
    const res = await gateway.chat({ chain: ["b-big"], messages });
    expect(res.costUsd).toBeCloseTo((2 * 1000 + 10 * 500) / 1e6);
  });

  it("falls through a 429 and skips the model until Retry-After passes", async () => {
    const { gateway, calls, advance } = setup({
      "a-big": [httpError(429, { "retry-after": "30" })],
    });
    expect((await gateway.chat({ chain, messages })).catalogId).toBe("b-big");
    const second = await gateway.chat({ chain, messages });
    expect(second.catalogId).toBe("b-big");
    expect(second.attempts[0]).toMatchObject({ catalogId: "a-big", outcome: "skipped" });
    advance(31_000);
    expect((await gateway.chat({ chain, messages })).catalogId).toBe("a-big");
    expect(calls).toEqual(["a-big", "b-big", "b-big", "a-big"]);
  });

  it("honours Groq's reset header and Gemini's RetryInfo", async () => {
    const gemini = Object.assign(new Error("[429 Too Many Requests] quota"), {
      status: 429,
      errorDetails: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "90s" }],
    });
    const { gateway, advance } = setup({
      "a-big": [httpError(429, { "x-ratelimit-reset-requests": "2m0.5s" })],
      "b-big": [gemini],
      "a-small": [],
    });
    await gateway.chat({ chain: [...chain, "a-small"], messages });
    advance(91_000);
    expect((await gateway.chat({ chain, messages })).catalogId).toBe("b-big");
    advance(30_000);
    expect((await gateway.chat({ chain, messages })).catalogId).toBe("a-big");
  });

  it("stops before a configured limit instead of spending a request on a 429", async () => {
    const { gateway, calls } = setup({});
    await gateway.chat({ chain, messages });
    await gateway.chat({ chain, messages });
    const third = await gateway.chat({ chain, messages });
    expect(third.catalogId).toBe("b-big");
    expect(third.attempts[0]?.detail).toBe("model rpm limit");
    expect(calls).toEqual(["a-big", "a-big", "b-big"]);
  });

  it("counts provider limits across the provider's models", async () => {
    const { gateway, advance } = setup({});
    await gateway.chat({ chain: ["a-big"], messages });
    await gateway.chat({ chain: ["a-small"], messages });
    advance(61_000);
    await gateway.chat({ chain: ["a-big"], messages });
    const res = await gateway.chat({ chain: ["a-small", "b-big"], messages });
    expect(res.attempts[0]?.detail).toBe("a rpd limit");
  });

  it("disables a retired model and says so", async () => {
    const { gateway, calls, logs, advance } = setup({ "a-big": [httpError(404)] });
    await gateway.chat({ chain, messages });
    advance(24 * 3_600_000);
    await gateway.chat({ chain, messages });
    expect(calls).toEqual(["a-big", "b-big", "b-big"]);
    expect(logs.some((l) => l.includes("a-big (big) is gone"))).toBe(true);
  });

  it("treats Groq's decommissioned 400 as gone", async () => {
    const decommissioned = Object.assign(httpError(400, {}, "model has been decommissioned"), {
      error: { code: "model_decommissioned" },
    });
    const { gateway } = setup({ "a-big": [decommissioned] });
    expect((await gateway.chat({ chain, messages })).catalogId).toBe("b-big");
  });

  it("falls through outages and timeouts", async () => {
    const timeout = Object.assign(new Error("Request timed out."), { name: "TimeoutError" });
    const { gateway } = setup({ "a-big": [httpError(503)], "b-big": [timeout] });
    const res = await gateway.chat({ chain: [...chain, "a-small"], messages });
    expect(res.catalogId).toBe("a-small");
    expect(res.attempts.map((a) => a.outcome)).toEqual(["unavailable", "unavailable", "ok"]);
  });

  it("fails at once on a bad key instead of hiding it behind the next model", async () => {
    const { gateway, calls } = setup({ "a-big": [httpError(401)] });
    await expect(gateway.chat({ chain, messages })).rejects.toBeInstanceOf(ModelCallFailed);
    expect(calls).toEqual(["a-big"]);
  });

  it("fails at once on a 403 even when its message mentions quota", async () => {
    const { gateway, calls } = setup({
      "a-big": [httpError(403, {}, "project has no quota access")],
    });
    await expect(gateway.chat({ chain, messages })).rejects.toBeInstanceOf(ModelCallFailed);
    expect(calls).toEqual(["a-big"]);
  });

  it("throws AllModelsExhausted with every attempt when the chain runs out", async () => {
    const { gateway } = setup({ "a-big": [httpError(429)], "b-big": [httpError(500)] });
    const error = await gateway.chat({ chain: [...chain, "c-big"], messages }).catch((e) => e);
    expect(error).toBeInstanceOf(AllModelsExhausted);
    expect(error.attempts).toEqual([
      expect.objectContaining({ catalogId: "a-big", outcome: "rate-limited" }),
      expect.objectContaining({ catalogId: "b-big", outcome: "unavailable" }),
      { catalogId: "c-big", outcome: "skipped", detail: "no C_KEY, C_ACCOUNT" },
    ]);
  });

  it("backs off longer each time a model is rate-limited without a reset time", async () => {
    const { gateway, advance, calls } = setup({ "a-big": [httpError(429), httpError(429)] });
    await gateway.chat({ chain, messages }); // strike 1: 60 s
    advance(61_000);
    await gateway.chat({ chain, messages }); // strike 2: 120 s
    advance(61_000);
    await gateway.chat({ chain, messages });
    expect(calls).toEqual(["a-big", "b-big", "a-big", "b-big", "b-big"]);
  });

  it("falls through the OpenAI SDK's connection error", async () => {
    const network = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    const connection = Object.assign(new Error("Connection error."), { cause: network });
    const { gateway } = setup({ "a-big": [connection] });
    const res = await gateway.chat({ chain, messages });
    expect(res.catalogId).toBe("b-big");
    expect(res.attempts[0]?.outcome).toBe("unavailable");
  });

  it("prefers Retry-After over Groq's whole-window reset headers", async () => {
    const tpm = httpError(429, { "retry-after": "7", "x-ratelimit-reset-requests": "2h13m" });
    const { gateway, advance } = setup({ "a-big": [tpm] });
    await gateway.chat({ chain, messages });
    advance(8_000);
    expect((await gateway.chat({ chain, messages })).catalogId).toBe("a-big");
  });

  it("backs off past a short retry hint when the 429s keep coming", async () => {
    const hint = () => httpError(429, { "retry-after": "30" });
    const { gateway, advance } = setup({ "a-big": [hint(), hint()] });
    await gateway.chat({ chain, messages }); // 30 s
    advance(31_000);
    await gateway.chat({ chain, messages }); // max(30 s, 120 s)
    advance(31_000);
    expect((await gateway.chat({ chain, messages })).catalogId).toBe("b-big");
    advance(90_000);
    expect((await gateway.chat({ chain, messages })).catalogId).toBe("a-big");
  });

  it("cools down every model of a provider whose quota is per account", async () => {
    const { gateway, calls } = setup({ "b-big": [httpError(429)] });
    await expect(gateway.chat({ chain: ["b-big", "b-small"], messages })).rejects.toBeInstanceOf(
      AllModelsExhausted,
    );
    expect(calls).toEqual(["b-big"]);
  });

  it("does not count an outage as a rate-limit strike", async () => {
    const { gateway, advance } = setup({ "a-big": [httpError(503), httpError(429)] });
    await gateway.chat({ chain, messages }); // 503: paused 30 s
    advance(31_000);
    await gateway.chat({ chain, messages }); // first 429: 60 s, not 120 s
    advance(61_000);
    expect((await gateway.chat({ chain, messages })).catalogId).toBe("a-big");
  });

  it("tries the run's sticky model first", async () => {
    const { gateway } = setup({});
    expect((await gateway.chat({ chain, messages, sticky: "b-big" })).catalogId).toBe("b-big");
    expect((await gateway.chat({ chain, messages, sticky: "a-small" })).catalogId).toBe("a-big");
  });

  it("passes tool choice to the model", async () => {
    const { gateway, options } = setup({});
    await gateway.chat({ chain, messages, tools: [], toolChoice: "any" });
    expect(options[0]?.toolChoice).toBe("any");
  });

  it("reads an epoch-seconds x-ratelimit-reset as a time, not a wait", async () => {
    const resetAt = Date.parse("2026-10-27T12:00:45Z") / 1000;
    const { gateway, advance } = setup({
      "a-big": [httpError(429, { "x-ratelimit-reset": String(resetAt) })],
    });
    await gateway.chat({ chain, messages });
    advance(46_000);
    expect((await gateway.chat({ chain, messages })).catalogId).toBe("a-big");
  });

  it("says whether an exhausted chain may answer later", async () => {
    const limited = await setup({ "a-big": [httpError(429)], "b-big": [httpError(404)] })
      .gateway.chat({ chain, messages })
      .catch((e) => e);
    expect(limited.transient).toBe(true);
    const { gateway, advance } = setup({ "a-big": [httpError(404)], "b-big": [httpError(404)] });
    await gateway.chat({ chain: [...chain, "c-big"], messages }).catch(() => {});
    advance(60_000);
    const gone = await gateway.chat({ chain: [...chain, "c-big"], messages }).catch((e) => e);
    expect(gone).toBeInstanceOf(AllModelsExhausted);
    expect(gone.transient).toBe(false);
  });
});
