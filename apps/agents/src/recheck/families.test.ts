import { describe, expect, it } from "vitest";
import { ModelRouter } from "../router.ts";
import { importFamilies } from "./run.ts";

const config = {
  providers: {},
  models: {
    sonnet: { provider: "anthropic", model: "claude-sonnet-5-5", family: "claude-sonnet-5-5" },
    routed: { provider: "openrouter", model: "anthropic/claude-haiku-5-5", family: "haiku" },
    gemma: { provider: "lmstudio", model: "google/gemma-4-12b", family: "gemma-4-12b" },
    oss: { provider: "lmstudio", model: "openai/gpt-oss-20b", family: "gpt-oss-20b" },
  },
  roles: {
    planner: ["oss"],
    desk: { default: ["oss"] },
    renderer: ["gemma"],
    "fact-checker": ["gemma", "sonnet", "oss"],
    "item-matcher": ["oss"],
    summariser: ["oss"],
  },
  tts: "gemma",
} as never;

describe("importFamilies", () => {
  it("names every Claude model, whoever serves it, and the renderer's chain (D169)", () => {
    const router = new ModelRouter(config);
    expect(importFamilies(config, router).sort()).toEqual([
      "claude-sonnet-5-5",
      "gemma-4-12b",
      "haiku",
    ]);
  });
});
