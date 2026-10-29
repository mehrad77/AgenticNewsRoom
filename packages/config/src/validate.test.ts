import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelsSchema } from "@anr/schemas";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./load.ts";
import { marksOpinion, showsMedia, validateConfig } from "./validate.ts";

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

  it("assigns an episode at a weekday and time, and a picked series only from its pick", () => {
    const config = loadConfig(root);
    const ai = config.newsrooms.find((n) => n.slug === "ai");
    if (!ai) throw new Error("ai newsroom missing");
    const podcast = ai.series["weekly-podcast"] as { assignment_at?: string };
    const classic = ai.series["weekly-classic"] as { assignment_at?: string; segments?: unknown };
    podcast.assignment_at = "08:00";
    classic.assignment_at = "mon 08:00";
    classic.segments = [{ kind: "story", minutes: 5, from: "week.daily-newsletter" }];
    const errors = validateConfig(config);
    expect(errors).toContain(
      'newsrooms/ai/series/weekly-podcast.yaml assignment_at: 08:00 must be a weekday and a time, like "fri 08:00"',
    );
    expect(errors).toContain(
      "newsrooms/ai/series/weekly-classic.yaml is assigned from its pick, so has no assignment_at",
    );
    expect(errors).toContain(
      "newsrooms/ai/series/weekly-classic.yaml has both segments and a pick",
    );
    delete podcast.assignment_at;
    expect(validateConfig(config)).toContain(
      "newsrooms/ai/series/weekly-podcast.yaml has segments but no assignment_at",
    );
  });

  it("requires owned or licensed sound cues for every podcast series (D108)", () => {
    const config = loadConfig(root);
    const ai = config.newsrooms.find((n) => n.slug === "ai");
    if (!ai) throw new Error("ai newsroom missing");
    ai.series["other-podcast"] = ai.series["weekly-podcast"];
    const errors = validateConfig(config);
    expect(errors).toContain(
      "newsrooms/ai/series/other-podcast.yaml has no audio/other-podcast/sting.flac",
    );
    expect(errors).toContain(
      "newsrooms/ai/series/other-podcast.yaml has no audio/other-podcast/LICENSE.md",
    );
  });

  it("requires the disclosure and, where items mark opinion, the opinion label in templates", () => {
    const copy = mkdtempSync(join(tmpdir(), "anr-config-"));
    cpSync(root, copy, { recursive: true });
    const site = join(copy, "formats", "artist-story", "templates", "site.liquid");
    writeFileSync(
      site,
      readFileSync(site, "utf8")
        .replace(/\{% render "opinion"[^%]*%\}/, "")
        .replace(/\{% render "media"[^%]*%\}/, ""),
    );
    const telegram = join(copy, "formats", "newsletter-issue", "templates", "telegram.liquid");
    writeFileSync(
      telegram,
      readFileSync(telegram, "utf8").replace(/\{%-? render "disclosure"[^%]*%\}/g, ""),
    );
    const errors = validateConfig(loadConfig(copy));
    expect(errors).toContain(
      "formats/artist-story/templates/site.liquid does not render the opinion label, and the format's items can be marked opinion",
    );
    expect(errors).toContain(
      "formats/newsletter-issue/templates/telegram.liquid does not render the disclosure partial",
    );
    expect(errors).toContain(
      "formats/artist-story/templates/site.liquid does not render the media partial, and the format's items can show images",
    );
    const schema = (f: string) =>
      JSON.parse(readFileSync(join(root, "formats", f, "schema.json"), "utf8"));
    expect(marksOpinion(schema("artist-story"))).toBe(true);
    expect(marksOpinion(schema("newsletter-issue"))).toBe(false);
    expect([showsMedia(schema("artist-story")), showsMedia(schema("classic-article"))]).toEqual([
      true,
      false,
    ]);
  });

  it("requires a written name for each host of a right-to-left language", () => {
    const config = loadConfig(root);
    const ai = config.newsrooms.find((n) => n.slug === "ai");
    if (!ai) throw new Error("ai newsroom missing");
    const podcast = ai.series["weekly-podcast"] as {
      host_names: Record<string, Record<string, string>>;
    };
    delete podcast.host_names.fa?.farzad;
    podcast.host_names.en = { someone: "Someone" };
    const errors = validateConfig(config);
    expect(errors).toContain("newsrooms/ai/series/weekly-podcast.yaml has no host_names.fa.farzad");
    expect(errors).toContain(
      "newsrooms/ai/series/weekly-podcast.yaml host_names.en.someone is not a host for en",
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

  it("keeps local servers out of the production models file (D84)", () => {
    const config = loadConfig(root);
    const prod = config.models["models.yaml"] as ModelsSchema;
    prod.providers.local = { kind: "openai", base_url: "http://127.0.0.1:1234/v1" };
    const errors = validateConfig(config);
    expect(errors).toContain(
      "models.yaml provider local: a local server belongs in a development profile",
    );
    expect(errors).toContain("models.yaml provider local: needs key_env");
  });

  it("sends reasoning_effort only to OpenAI-compatible providers (D85)", () => {
    const config = loadConfig(root);
    const m = freeModels(config);
    if (m.models["gemini-flash"]) m.models["gemini-flash"].reasoning_effort = "none";
    const errors = validateConfig(config);
    expect(errors).toContain(
      "models.free.yaml model gemini-flash: reasoning_effort needs an OpenAI-compatible provider",
    );
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
