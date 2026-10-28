// The podcast on the site, on anr_test (D110): a feed of the items the publisher stored, and
// downloads counted once per listener and day without keeping who listened.
import { createTestNewsroom, testPools } from "@anr/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  countDownload,
  daySecret,
  episodeAudio,
  listenerKey,
  podcastFeed,
  podcastRoute,
} from "./podcast.ts";
import { newsroomBySubdomain, type ReaderNewsroom } from "./reader.ts";

const pools = testPools();
afterAll(() => pools.end());
let newsroom: ReaderNewsroom;
const ids = { published: "", held: "" };

beforeAll(async () => {
  const id = await createTestNewsroom(pools.system, "pod");
  await pools.system.query(
    `update newsrooms set languages = '{en}', timezone = 'Europe/Istanbul', name = '{"en": "AI Newsroom"}' where id = $1`,
    [id],
  );
  const subdomain = (
    await pools.system.query<{ subdomain: string }>(
      "select subdomain from newsrooms where id = $1",
      [id],
    )
  ).rows[0]?.subdomain as string;
  newsroom = (await newsroomBySubdomain(pools.app, subdomain)) as ReaderNewsroom;
  const one = async (sql: string, params: unknown[]) =>
    ((await pools.system.query(sql, params)).rows[0] as { id: string }).id;
  const series = await one(
    `insert into series (newsroom_id, slug, format_id, languages, config)
     select $1, 'weekly-podcast', f.id, '{en}', '{"name": {"en": "Weekly Podcast"}, "channels": {"podcast-rss": ["en"]}}'
     from formats f where f.slug = 'podcast-episode' returning id`,
    [id],
  );
  const channel = await one(
    "insert into channels (newsroom_id, kind, language) values ($1, 'podcast-rss', 'en') returning id",
    [id],
  );
  for (const [name, status, slot] of [
    ["published", "published", "2026-11-06T15:00:00Z"],
    ["held", "with-editor", "2026-11-13T15:00:00Z"],
  ] as const) {
    const assignment = await one(
      "insert into assignments (newsroom_id, series_id, slot) values ($1, $2, $3) returning id",
      [id, series, slot],
    );
    const story = await one(
      "insert into stories (newsroom_id, assignment_id) values ($1, $2) returning id",
      [id, assignment],
    );
    const rendition = await one(
      `insert into renditions (newsroom_id, story_id, format_id, language, body)
       select $1, $2, f.id, 'en', '{}' from formats f where f.slug = 'podcast-episode' returning id`,
      [id, story],
    );
    const pub = await one(
      `insert into publications (newsroom_id, series_id, assignment_id, slot, language, status)
       values ($1, $2, $3, $4, 'en', $5) returning id`,
      [id, series, assignment, slot, status],
    );
    ids[name] = pub;
    await pools.system.query(
      `insert into posts (newsroom_id, publication_id, channel_id, part, idempotency_key, body, status)
       values ($1, $2::uuid, $3, 1, $2::text || ':1', $4, 'sent')`,
      [id, pub, channel, `<item><title>${name}</title></item>`],
    );
    await pools.system.query(
      `insert into episodes (newsroom_id, publication_id, rendition_id, script_hash, media_key, bytes, seconds,
                             digital_source_type, signed)
       values ($1, $2, $3, 'h', $4, 1000, 60, 'x', true)`,
      [id, pub, rendition, `episodes/${pub}/h.mp3`],
    );
  }
});

const site = () => ({
  subdomain: newsroom.subdomain,
  rootDomain: "example.test",
  languages: newsroom.languages,
});

describe("the podcast on the site (D110)", () => {
  it("knows the feed and audio paths", () => {
    const id = "0b2f6f0e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
    expect(podcastRoute(`/a/${id}.mp3`)).toEqual({ kind: "audio", publicationId: id });
    expect(podcastRoute("/podcast/weekly-podcast.xml")).toEqual({
      kind: "feed",
      series: "weekly-podcast",
    });
    expect(podcastRoute("/a/1.mp3")).toBeNull();
  });

  it("serves the feed from stored items of published episodes only, with the AI label", async () => {
    const feed = await podcastFeed(pools.app, newsroom, "en", "weekly-podcast", site(), "AI-made");
    expect(feed).toContain("<title>Weekly Podcast</title>");
    expect(feed).toContain("AI-made");
    expect(feed).toContain("<item><title>published</title></item>");
    expect(feed).not.toContain("held");
    expect(await podcastFeed(pools.app, newsroom, "fa", "weekly-podcast", site(), "x")).toBeNull();
  });

  it("finds audio only for a published episode", async () => {
    expect(await episodeAudio(pools.app, newsroom, ids.published)).toBe(
      `episodes/${ids.published}/h.mp3`,
    );
    expect(await episodeAudio(pools.app, newsroom, ids.held)).toBeNull();
  });

  it("counts a listener once a day, never keeps the address, and ignores crawlers", async () => {
    const now = new Date("2026-11-07T10:00:00Z");
    const app = "AppleCoreMedia/1.0";
    expect(await countDownload(pools.app, newsroom, ids.published, "203.0.113.7", app, now)).toBe(
      true,
    );
    expect(await countDownload(pools.app, newsroom, ids.published, "203.0.113.7", app, now)).toBe(
      false,
    );
    expect(await countDownload(pools.app, newsroom, ids.published, "203.0.113.8", app, now)).toBe(
      true,
    );
    expect(
      await countDownload(pools.app, newsroom, ids.published, "203.0.113.9", "Googlebot", now),
    ).toBe(false);
    const next = new Date("2026-11-08T10:00:00Z");
    expect(await countDownload(pools.app, newsroom, ids.published, "203.0.113.7", app, next)).toBe(
      true,
    );
    const { rows } = await pools.system.query<{ day: string; count: number }>(
      "select day::text, count from downloads where publication_id = $1 order by day",
      [ids.published],
    );
    expect(rows).toEqual([
      { day: "2026-11-07", count: 2 },
      { day: "2026-11-08", count: 1 },
    ]);
    const { rows: keys } = await pools.system.query<{ key: Buffer }>(
      "select key from download_keys where publication_id = $1",
      [ids.published],
    );
    expect(keys.every((k) => !k.key.toString("latin1").includes("203.0.113"))).toBe(true);
    // The same listener on two days has two unrelated keys.
    expect(listenerKey(daySecret("2026-11-07"), "203.0.113.7", app)).not.toEqual(
      listenerKey(daySecret("2026-11-08"), "203.0.113.7", app),
    );
  });
});
