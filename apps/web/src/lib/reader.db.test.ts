// Reader queries on anr_test: only published and corrected pieces of the site's own newsroom.
import { createTestNewsroom, testPools } from "@anr/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  countView,
  latest,
  newsroomBySubdomain,
  publicationByPath,
  type ReaderNewsroom,
  search,
} from "./reader.ts";

const pools = testPools();
afterAll(() => pools.end());

let newsroom: ReaderNewsroom;
let other = "";

async function piece(
  newsroomId: string,
  o: { day: string; status: string; title: string; text: string; opinion?: boolean },
) {
  const sys = pools.system;
  const one = async (sql: string, params: unknown[]) =>
    ((await sys.query(sql, params)).rows[0] as { id: string }).id;
  const series = await sys.query<{ id: string }>(
    "select id from series where newsroom_id = $1 and slug = 'daily-newsletter'",
    [newsroomId],
  );
  const seriesId =
    series.rows[0]?.id ??
    (await one(
      `insert into series (newsroom_id, slug, format_id, languages, config)
       select $1, 'daily-newsletter', f.id, '{en}', '{"name": {"en": "Daily Newsletter"}}'
       from formats f where f.slug = 'newsletter-issue' returning id`,
      [newsroomId],
    ));
  const beatId = await one(
    `insert into beats (newsroom_id, slug, status, media_topics)
     values ($1, $2, 'open', '{medtop:20000763}') returning id`,
    [newsroomId, `labs-${o.day}`],
  );
  const slot = new Date(`${o.day}T18:00:00Z`);
  const assignmentId = await one(
    "insert into assignments (newsroom_id, series_id, slot) values ($1, $2, $3) returning id",
    [newsroomId, seriesId, slot],
  );
  const storyId = await one(
    "insert into stories (newsroom_id, assignment_id, beat_id) values ($1, $2, $3) returning id",
    [newsroomId, assignmentId, beatId],
  );
  await sys.query(
    `insert into claims (newsroom_id, story_id, ref, kind, text)
     values ($1, $2, 'c1', 'opinion', 'An opinion.')`,
    [newsroomId, storyId],
  );
  const body = {
    language: "en",
    title: o.title,
    items: [{ kind: "news", headline: "H", body: o.text, claim_ids: o.opinion ? ["c1"] : [] }],
  };
  const renditionId = await one(
    `insert into renditions (newsroom_id, story_id, format_id, language, body)
     select $1, $2, f.id, 'en', $3 from formats f where f.slug = 'newsletter-issue' returning id`,
    [newsroomId, storyId, JSON.stringify(body)],
  );
  const path = `/daily-newsletter/${o.day}`;
  const publicationId = await one(
    `insert into publications (newsroom_id, series_id, assignment_id, slot, language, status,
                               published_at, path, title, search_text)
     values ($1, $2, $3, $4, 'en', $5, $6, $7, $8, $9) returning id`,
    [
      newsroomId,
      seriesId,
      assignmentId,
      slot,
      o.status,
      o.status === "published" ? slot : null,
      path,
      o.title,
      `${o.title}\nH\n${o.text}`,
    ],
  );
  await sys.query(
    `insert into publication_renditions (newsroom_id, publication_id, position, rendition_id)
     values ($1, $2, 1, $3)`,
    [newsroomId, publicationId, renditionId],
  );
  return { publicationId, path };
}

beforeAll(async () => {
  const id = await createTestNewsroom(pools.system, "web");
  const { rows } = await pools.system.query<{ subdomain: string }>(
    "select subdomain from newsrooms where id = $1",
    [id],
  );
  newsroom = (await newsroomBySubdomain(pools.app, rows[0]?.subdomain ?? "")) as ReaderNewsroom;
  await piece(id, {
    day: "2026-10-26",
    status: "published",
    title: "Orbit ships",
    text: "Example Lab released Orbit.",
  });
  await piece(id, {
    day: "2026-10-27",
    status: "published",
    title: "Nova opens",
    text: "Nova Labs opened an office in Berlin.",
    opinion: true,
  });
  await piece(id, {
    day: "2026-10-28",
    status: "with-editor",
    title: "Held piece",
    text: "Orbit secret draft.",
  });
  other = await createTestNewsroom(pools.system, "web");
  await piece(other, {
    day: "2026-10-26",
    status: "published",
    title: "Other Orbit",
    text: "Orbit in another newsroom.",
  });
});

describe("reader queries", () => {
  it("find the newsroom by subdomain", () => {
    expect(newsroom).toMatchObject({ languages: ["en"], timezone: "UTC" });
  });

  it("list only published pieces of this newsroom, newest first", async () => {
    const list = await latest(pools.app, newsroom.id, "en");
    expect(list.map((x) => x.title)).toEqual(["Nova opens", "Orbit ships"]);
  });

  it("never show a held piece, even by its path", async () => {
    expect(
      await publicationByPath(pools.app, newsroom.id, "en", "/daily-newsletter/2026-10-28"),
    ).toBeNull();
    expect(
      await publicationByPath(pools.app, other, "en", "/daily-newsletter/2026-10-27"),
    ).toBeNull();
  });

  it("read a publication with its topics, genres and rendition", async () => {
    const p = await publicationByPath(pools.app, newsroom.id, "en", "/daily-newsletter/2026-10-27");
    expect(p).toMatchObject({
      title: "Nova opens",
      format: "newsletter-issue",
      genres: ["genre:Summary", "genre:Opinion"],
      mediaTopics: ["medtop:20000763"],
      edited: false,
      corrections: [],
    });
    const plain = await publicationByPath(
      pools.app,
      newsroom.id,
      "en",
      "/daily-newsletter/2026-10-26",
    );
    expect(plain?.genres).toEqual(["genre:Summary"]);
  });

  it("search published text by trigram similarity, never drafts or other newsrooms", async () => {
    const hits = await search(pools.app, newsroom.id, "en", "orbit");
    expect(hits.map((x) => x.title)).toEqual(["Orbit ships"]);
    expect(await search(pools.app, newsroom.id, "en", "secret draft")).toEqual([]);
    expect(await search(pools.app, newsroom.id, "en", "x")).toEqual([]);
  });

  it("count a reader's view without cookies, and skip robots", async () => {
    const p = await publicationByPath(pools.app, newsroom.id, "en", "/daily-newsletter/2026-10-26");
    const id = p?.id ?? "";
    expect(await countView(pools.app, newsroom, id, "Mozilla/5.0 (Macintosh)")).toBe(true);
    expect(await countView(pools.app, newsroom, id, "Mozilla/5.0 (Macintosh)")).toBe(true);
    expect(await countView(pools.app, newsroom, id, "Googlebot/2.1")).toBe(false);
    expect(await countView(pools.app, newsroom, id, null)).toBe(false);
    const { rows } = await pools.system.query(
      "select count from page_views where publication_id = $1",
      [id],
    );
    expect(rows).toEqual([{ count: 2 }]);
  });
});
