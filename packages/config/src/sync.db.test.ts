import { fileURLToPath } from "node:url";
import { createBoss, type Pool } from "@anr/db";
import { testDatabaseUrl, testPools } from "@anr/db/testing";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type RawConfig } from "./load.ts";
import { syncConfig } from "./sync.ts";

const root = fileURLToPath(new URL("../../../config", import.meta.url));
const pools = testPools();
let boss: PgBoss;

/** The repo's config with the AI newsroom renamed, so runs never collide in anr_test. */
function testConfig(suffix: string): RawConfig {
  const config = loadConfig(root);
  const ai = config.newsrooms.find((n) => n.slug === "ai");
  if (!ai) throw new Error("ai newsroom missing");
  const slug = `ai-${suffix}`;
  ai.slug = slug;
  Object.assign(ai.newsroom as object, { slug, subdomain: slug });
  config.newsrooms = [ai];
  return config;
}

/** The test newsroom's beats, to edit in a test config. */
function beatsOf(config: RawConfig): Record<string, unknown> {
  const policy = config.newsrooms[0]?.policy as { beats: Record<string, unknown> } | undefined;
  if (!policy) throw new Error("test newsroom has no policy");
  return policy.beats;
}

const rows = (pool: Pool, sql: string, params: unknown[]) =>
  pool.query(sql, params).then((r) => r.rows);

beforeAll(async () => {
  boss = createBoss(testDatabaseUrl(process.env.DATABASE_SYSTEM_URL ?? ""), "sync-test", {
    schedule: false,
    supervise: false,
  });
  await boss.start();
});
afterAll(async () => {
  await boss.stop({ graceful: false });
  await pools.end();
});

describe("syncConfig", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const slug = `ai-${suffix}`;
  const ids = async () =>
    rows(
      pools.system,
      `select b.slug, b.id, b.removed_at is not null as removed, b.media_topics
       from beats b join newsrooms n on n.id = b.newsroom_id where n.slug = $1 order by b.slug`,
      [slug],
    );

  it("loads a newsroom with its beats, Media Topics, sources and series", async () => {
    const report = await syncConfig(pools.system, boss, testConfig(suffix));
    expect(report.newsrooms.added).toBe(1);
    // Removed counts include other test newsrooms in anr_test, which are not in this config.
    expect(report.beats.added).toBe(4);
    expect(report.sources.added).toBe(7);
    expect(report.series.added).toBe(3);
    const beats = await ids();
    expect(beats.find((b) => b.slug === "research")?.media_topics).toEqual([
      "medtop:20001298",
      "medtop:20000735",
    ]);
    const [format] = await rows(pools.system, "select genre from formats where slug = $1", [
      "newsletter-issue",
    ]);
    expect(format).toEqual({ genre: "genre:Summary" });
  });

  it("keeps every id on a second sync", async () => {
    const before = await ids();
    const report = await syncConfig(pools.system, boss, testConfig(suffix));
    expect(report.beats).toMatchObject({ added: 0, kept: 4 });
    expect(await ids()).toEqual(before);
  });

  it("soft-deletes an item that leaves the config and revives it with its id", async () => {
    const before = await ids();
    const without = testConfig(suffix);
    delete beatsOf(without).policy;
    expect((await syncConfig(pools.system, boss, without)).beats.removed).toBeGreaterThanOrEqual(1);
    expect((await ids()).find((b) => b.slug === "policy")?.removed).toBe(true);

    await syncConfig(pools.system, boss, testConfig(suffix));
    expect(await ids()).toEqual(before);
  });

  it("soft-deletes a removed newsroom's items with it and revives them with their ids", async () => {
    const before = await ids();
    const without = testConfig(suffix);
    without.newsrooms = [];
    expect((await syncConfig(pools.system, boss, without)).beats.removed).toBeGreaterThanOrEqual(4);
    expect((await ids()).every((b) => b.removed)).toBe(true);

    await syncConfig(pools.system, boss, testConfig(suffix));
    expect(await ids()).toEqual(before);
  });

  it("schedules no source before a person checks its terms (D17), then reconciles", async () => {
    const newsroomId = (
      await rows(pools.system, "select id from newsrooms where slug = $1", [slug])
    )[0]?.id as string;
    const mine = async (queue: string) =>
      (await boss.getSchedules(queue)).filter(
        (s) => (s.data as { newsroomId?: string }).newsroomId === newsroomId,
      );
    expect(await mine("ingest-source")).toEqual([]);
    expect((await mine("assign")).map((s) => [s.cron, s.timezone])).toEqual([
      ["0 16 * * *", "Europe/Istanbul"],
    ]);

    const checked = testConfig(suffix);
    const sources = checked.newsrooms[0]?.sources as { id: string; terms_checked?: string }[];
    const openai = sources.find((s) => s.id === "openai-news");
    if (openai) openai.terms_checked = "2026-10-26";
    await syncConfig(pools.system, boss, checked);
    expect((await mine("ingest-source")).map((s) => s.cron)).toEqual(["0 */1 * * *"]);

    const report = await syncConfig(pools.system, boss, testConfig(suffix));
    expect(report.schedules.unscheduled).toBeGreaterThanOrEqual(1);
    expect(await mine("ingest-source")).toEqual([]);
  });

  it("refuses an invalid config and changes nothing", async () => {
    const before = await ids();
    const broken = testConfig(suffix);
    beatsOf(broken).labs = {
      status: "open",
      media_topics: ["medtop:99999999"],
    };
    await expect(syncConfig(pools.system, boss, broken)).rejects.toThrow("config is invalid");
    expect(await ids()).toEqual(before);
  });
});
