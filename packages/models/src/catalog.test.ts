import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import {
  buildCatalog,
  DEFAULT_TIMEOUT_MS,
  loadModelsConfig,
  missingKeys,
  modelsFile,
  NO_KEY,
  roleChains,
} from "./catalog.ts";
import { probe } from "./probe.ts";

const configDir = fileURLToPath(new URL("../../../config", import.meta.url));

describe("catalog", () => {
  it("picks the models file from ANR_MODELS", () => {
    expect(modelsFile(configDir, "")).toBe(join(configDir, "models.yaml"));
    expect(modelsFile(configDir, "free")).toBe(join(configDir, "models.free.yaml"));
    expect(() => modelsFile(configDir, "../x")).toThrow();
  });

  it("needs no key for a local server, and takes its longer deadline", () => {
    const config = loadModelsConfig(modelsFile(configDir, "free"));
    config.providers.local = {
      kind: "openai",
      base_url: "http://127.0.0.1:1234/v1",
      timeout_s: 600,
    };
    config.models["local-gemma"] = {
      provider: "local",
      model: "google/gemma-4-31b",
      family: "gemma-4-31b",
      tools: true,
    };
    const catalog = buildCatalog(config, {});
    const local = catalog.entries.get("local-gemma");
    expect(local).toMatchObject({ apiKey: NO_KEY, missingEnv: [], timeoutMs: 600_000 });
    expect(catalog.entries.get("gemini-flash")?.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("fills the Cloudflare account into its URL and names missing env vars", () => {
    const config = loadModelsConfig(modelsFile(configDir, "free"));
    config.providers.cloudflare = {
      kind: "openai",
      base_url: "https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1",
      account_env: "CLOUDFLARE_ACCOUNT_ID",
      key_env: "CLOUDFLARE_AI_API_TOKEN",
    };
    config.models["cloudflare-qwen"] = {
      provider: "cloudflare",
      model: "@cf/qwen/qwen3.8-27b",
      family: "qwen3.8-27b",
      tools: true,
    };
    config.roles.summariser = [...config.roles.summariser, "cloudflare-qwen"];
    const catalog = buildCatalog(config, { CLOUDFLARE_ACCOUNT_ID: "acc", GEMINI_API_KEY: "g" });
    const cf = catalog.entries.get("cloudflare-qwen");
    expect(cf?.baseUrl).toBe("https://api.cloudflare.com/client/v4/accounts/acc/ai/v1");
    expect(cf?.apiKey).toBeUndefined();
    expect(catalog.entries.get("gemini-flash")?.apiKey).toBe("g");
    expect(missingKeys(catalog)).toEqual([
      "CLOUDFLARE_AI_API_TOKEN",
      "GROQ_API_KEY",
      "MISTRAL_API_KEY",
      "NVIDIA_API_KEY",
      "OPENROUTER_API_KEY",
    ]);
  });

  it("needs only the Gemini key for the production models file", () => {
    const catalog = buildCatalog(loadModelsConfig(modelsFile(configDir, "")), {});
    expect(missingKeys(catalog)).toEqual(["GEMINI_API_KEY"]);
  });

  it("resolves Claude models from the Anthropic key, in no role chain yet", () => {
    for (const profile of ["", "free"]) {
      const config = loadModelsConfig(modelsFile(configDir, profile));
      const catalog = buildCatalog(config, { ANTHROPIC_API_KEY: "sk" });
      expect(catalog.entries.get("claude-opus")).toMatchObject({
        kind: "anthropic",
        model: "claude-opus-5-5",
        family: "claude-opus-5-5",
        apiKey: "sk",
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      const chained = roleChains(config).flatMap(([, chain]) => chain);
      expect(chained.filter((id) => id.startsWith("claude-"))).toEqual([]);
      expect(buildCatalog(config, {}).entries.get("claude-sonnet")?.missingEnv).toEqual([
        "ANTHROPIC_API_KEY",
      ]);
    }
  });
});

describe("probe", () => {
  it("reports models without keys, without tool calls, and gone", async () => {
    const config = loadModelsConfig(modelsFile(configDir, "free"));
    const catalog = buildCatalog(config, { GROQ_API_KEY: "k" });
    const rows = await probe(catalog, (entry) => ({
      async invoke() {
        if (entry.id === "groq-qwen") throw Object.assign(new Error("not found"), { status: 404 });
        if (entry.id === "groq-gpt-oss-20b") return new AIMessage("pong");
        return new AIMessage({ content: "", tool_calls: [{ name: "ping", args: { ok: true } }] });
      },
    }));
    const outcome = (id: string) => rows.find((r) => r.catalogId === id)?.outcome;
    expect(outcome("groq-gpt-oss-120b")).toBe("ok");
    expect(outcome("groq-gpt-oss-20b")).toBe("no-tools");
    expect(outcome("groq-qwen")).toBe("gone");
    expect(outcome("gemini-flash")).toBe("no-key");
    expect(rows.some((r) => r.catalogId === "gemini-flash-tts")).toBe(false);
  });

  it("skips an Anthropic model without its key, calling nothing", async () => {
    const config = loadModelsConfig(modelsFile(configDir, ""));
    config.roles.summariser = [...config.roles.summariser, "claude-haiku"];
    const called: string[] = [];
    const rows = await probe(buildCatalog(config, {}), (entry) => ({
      async invoke() {
        called.push(entry.id);
        return new AIMessage({ content: "", tool_calls: [{ name: "ping", args: { ok: true } }] });
      },
    }));
    expect(rows.find((r) => r.catalogId === "claude-haiku")).toMatchObject({
      outcome: "no-key",
      model: "anthropic/claude-haiku-5-5",
      detail: "ANTHROPIC_API_KEY",
    });
    expect(called.filter((id) => id.startsWith("claude-"))).toEqual([]);
  });
});
