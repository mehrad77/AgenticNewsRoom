import { fileURLToPath } from "node:url";
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

  it("requires two distinct fact-checker models", () => {
    const config = loadConfig(root);
    const models = config.models as {
      roles: { "fact-checker": { candidates: { provider: string; model: string }[] } };
    };
    const first = models.roles["fact-checker"].candidates[0];
    if (!first) throw new Error("no candidates");
    models.roles["fact-checker"].candidates = [first, { ...first }];
    expect(validateConfig(config)).toContain(
      "models.yaml fact-checker needs at least two distinct candidate models",
    );
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
    config.formatMeta["classic-article"] = { genre: "genre:Wrapup", ninjs_type: "text" };
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
});
