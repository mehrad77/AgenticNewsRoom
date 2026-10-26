import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { buildCatalog, loadModelsConfig, missingKeys, modelsFile } from "./catalog.ts";
import { probe } from "./probe.ts";

const configDir = fileURLToPath(new URL("../../../config", import.meta.url));

describe("catalog", () => {
  it("picks the models file from ANR_MODELS", () => {
    expect(modelsFile(configDir, "")).toBe(join(configDir, "models.yaml"));
    expect(modelsFile(configDir, "free")).toBe(join(configDir, "models.free.yaml"));
    expect(() => modelsFile(configDir, "../x")).toThrow();
  });

  it("fills the Cloudflare account into its URL and names missing env vars", () => {
    const config = loadModelsConfig(modelsFile(configDir, "free"));
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
});
