import { fileURLToPath } from "node:url";
import type { ModelsSchema } from "@anr/schemas";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./load.ts";
import { validateConfig } from "./validate.ts";

const root = fileURLToPath(new URL("../../../config", import.meta.url));

describe("validateConfig", () => {
  it("accepts the repo's config", () => {
    expect(validateConfig(loadConfig(root))).toEqual([]);
  });

  it("rejects a series in a language its newsroom does not write", () => {
    const config = loadConfig(root);
    const ai = config.newsrooms.find((n) => n.slug === "ai");
    if (!ai) throw new Error("ai newsroom missing");
    const series = ai.series["daily-newsletter"] as { languages: string[] };
    series.languages = [...series.languages, "tr"];
    expect(validateConfig(config)).toContain(
      "newsrooms/ai/series/daily-newsletter.yaml language tr is not a newsroom language",
    );
  });

  it("requires a narrator voice per language when a podcast tells a story", () => {
    const config = loadConfig(root);
    const kultur = config.newsrooms.find((n) => n.slug === "kultur");
    if (!kultur) throw new Error("kultur newsroom missing");
    const podcast = kultur.series["weekly-podcast"] as { narrator: Record<string, string> };
    delete podcast.narrator.fa;
    expect(validateConfig(config)).toContain(
      "newsrooms/kultur/series/weekly-podcast.yaml has no narrator voice for fa",
    );
  });

  it("reads every models file", () => {
    expect(Object.keys(loadConfig(root).models)).toEqual(["models.free.yaml", "models.yaml"]);
  });

  const freeModels = (config: ReturnType<typeof loadConfig>) =>
    config.models["models.free.yaml"] as ModelsSchema;

  it("requires fact-checker models from two families, not just two ids", () => {
    const config = loadConfig(root);
    const m = freeModels(config);
    // The same weights from two providers are one family.
    const groq = m.models["groq-gpt-oss-120b"];
    if (!groq) throw new Error("groq-gpt-oss-120b missing");
    m.models["other-gpt-oss-120b"] = { ...groq };
    m.roles["fact-checker"] = ["groq-gpt-oss-120b", "other-gpt-oss-120b"];
    expect(validateConfig(config)).toContain(
      "models.free.yaml fact-checker needs models from at least two families",
    );
  });

  it("rejects unknown models, models without tools, and web access", () => {
    const config = loadConfig(root);
    const m = freeModels(config);
    m.roles.planner = ["no-such-model", "gemini-flash-tts"];
    m.models.web = { provider: "openrouter", model: "x/y:online", family: "y", tools: true };
    m.models.orphan = { provider: "nowhere", model: "z", family: "z", tools: true };
    const errors = validateConfig(config);
    expect(errors).toContain("models.free.yaml planner: unknown model no-such-model");
    expect(errors).toContain("models.free.yaml planner: gemini-flash-tts has no tool calling");
    expect(errors).toContain("models.free.yaml model web: x/y:online has web access");
    expect(errors).toContain("models.free.yaml model orphan: unknown provider nowhere");
  });

  it("requires a price on every model a role or TTS uses (D82)", () => {
    const config = loadConfig(root);
    const m = freeModels(config);
    delete m.models["gemini-flash"]?.price;
    delete m.models[m.tts]?.price;
    const errors = validateConfig(config);
    expect(errors).toContain("models.free.yaml planner: gemini-flash has no price");
    expect(errors).toContain(`models.free.yaml tts: ${m.tts} has no price`);
  });

  it("requires models.yaml and known formats in desk.by_format", () => {
    const config = loadConfig(root);
    freeModels(config).roles.desk.by_format = { "no-such-format": ["gemini-flash"] };
    delete config.models["models.yaml"];
    const errors = validateConfig(config);
    expect(errors).toContain("config has no models.yaml");
    expect(errors).toContain("models.free.yaml desk.by_format: unknown format no-such-format");
  });

  it("rejects unknown and retired IPTC Media Topics on beats", () => {
    const config = loadConfig(root);
    const ai = config.newsrooms.find((n) => n.slug === "ai");
    if (!ai) throw new Error("ai newsroom missing");
    const beats = (ai.policy as { beats: Record<string, { media_topics: string[] }> }).beats;
    beats.labs = { ...beats.labs, media_topics: ["medtop:99999999", "medtop:20000030"] };
    const errors = validateConfig(config);
    expect(errors).toContain(
      "newsrooms/ai/policy.yaml beat labs: medtop:99999999 is not a live IPTC Media Topic",
    );
    // medtop:20000030 (music theatre) was retired by IPTC.
    expect(errors).toContain(
      "newsrooms/ai/policy.yaml beat labs: medtop:20000030 is not a live IPTC Media Topic",
    );
  });

  it("requires a live IPTC genre per format", () => {
    const config = loadConfig(root);
    config.formatMeta["classic-article"] = {
      genre: "genre:Wrapup",
      ninjs_type: "text",
      run_tokens: 200_000,
    };
    delete config.formatMeta["artist-story"];
    const errors = validateConfig(config);
    expect(errors).toContain(
      "formats/classic-article/format.yaml genre genre:Wrapup is not a live IPTC genre",
    );
    expect(errors).toContain("formats/artist-story has no format.yaml");
  });

  it("reports missing newsroom files instead of crashing", () => {
    const config = loadConfig(root);
    const ai = config.newsrooms.find((n) => n.slug === "ai");
    if (!ai) throw new Error("ai newsroom missing");
    ai.policy = undefined;
    ai.sources = undefined;
    const errors = validateConfig(config);
    expect(errors).toContain("newsrooms/ai has no policy.yaml");
    expect(errors).toContain("newsrooms/ai has no sources.yaml");
  });

  it("rejects a source interval cron cannot repeat evenly", () => {
    const config = loadConfig(root);
    const ai = config.newsrooms.find((n) => n.slug === "ai");
    if (!ai) throw new Error("ai newsroom missing");
    const [first] = ai.sources as { id: string; every: string }[];
    if (!first) throw new Error("no sources");
    first.every = "45m";
    expect(validateConfig(config)).toContain(
      `newsrooms/ai/sources.yaml source ${first.id}: interval 45m must divide an hour (m) or a day (h), or be 1d`,
    );
  });

  it("rejects an assignment time and a timezone pg-boss cannot schedule", () => {
    const config = loadConfig(root);
    const ai = config.newsrooms.find((n) => n.slug === "ai");
    if (!ai) throw new Error("ai newsroom missing");
    (ai.series["daily-newsletter"] as { assignment_at: string }).assignment_at = "24:30";
    (ai.newsroom as { timezone: string }).timezone = "Europe/Istambul";
    const errors = validateConfig(config);
    expect(errors).toContain(
      "newsrooms/ai/series/daily-newsletter.yaml assignment_at: time 24:30 must be 00:00 to 23:59",
    );
    expect(errors).toContain(
      "newsrooms/ai/newsroom.yaml timezone Europe/Istambul is not an IANA timezone",
    );
  });
});
