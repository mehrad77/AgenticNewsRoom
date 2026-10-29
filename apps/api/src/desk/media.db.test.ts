// Media items at the desk on anr_test (D16, D119): adding queues ingestion's fetch, a person
// records a press kit's licence with the credit, and a recorded licence never changes.
import { randomBytes } from "node:crypto";
import { platformKey } from "@anr/db";
import { createTestNewsroom, testPools } from "@anr/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";

const pools = testPools();
afterAll(() => pools.end());
const sent: { queue: string; data: unknown }[] = [];
const boss = {
  send: async (queue: string, data: object) => {
    sent.push({ queue, data });
    return "job";
  },
};
const editor = `media-${randomBytes(4).toString("hex")}@example.test`;
const app = createApp({
  pool: pools.app,
  boss: boss as never,
  platform: platformKey(randomBytes(32).toString("base64")),
  verify: async () => editor,
  site: { rootDomain: "example.test" },
});

const one = async (sql: string, params: unknown[]) =>
  ((await pools.system.query(sql, params)).rows[0] as { id: string }).id;
let newsroomId = "";
let slug = "";
let userId = "";
let leadId = "";

/** A media row as ingestion stores it: Photo Metadata from XMP, no licence yet. */
const media = (sourceUrl: string, credit: string | null) =>
  one(
    `insert into media (newsroom_id, file, source_url, file_url, content_type, credit_line, added_by)
     values ($1, $2, $3, $3, 'image/jpeg', $4, $5) returning id`,
    [newsroomId, `raw/${randomBytes(8).toString("hex")}`, sourceUrl, credit, userId],
  );

beforeAll(async () => {
  newsroomId = await createTestNewsroom(pools.system, "media");
  slug = (
    await pools.system.query<{ slug: string }>("select slug from newsrooms where id = $1", [
      newsroomId,
    ])
  ).rows[0]?.slug as string;
  userId = await one("insert into users (email) values ($1) returning id", [editor]);
  await pools.system.query(
    "insert into memberships (newsroom_id, user_id, role) values ($1, $2, 'editor')",
    [newsroomId, userId],
  );
  leadId = await one(
    `insert into leads (newsroom_id, uri, headline, body, language, content_hash, tier)
     values ($1, 'https://label.example/news', 'Album', 'An album.', 'en', 'h', 1) returning id`,
    [newsroomId],
  );
});

const post = (path: string, body: unknown) =>
  app.request(`/desk/newsrooms/${slug}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("media items (D119)", () => {
  it("queues ingestion for a Commons file page or a press kit image with its page", async () => {
    sent.length = 0;
    const commons = "https://commons.wikimedia.org/wiki/File:Example.jpg";
    expect((await post("/media", { url: commons })).status).toBe(400);
    expect((await post("/media", { url: commons, lead_id: leadId })).status).toBe(202);
    expect(
      (await post("/media", { url: "https://label.example/a.jpg", lead_id: leadId })).status,
    ).toBe(400);
    const kit = {
      url: "https://label.example/a.jpg",
      source_url: "https://label.example/press",
      lead_id: leadId,
    };
    expect((await post("/media", kit)).status).toBe(202);
    expect(sent).toEqual([
      { queue: "ingest-media", data: { newsroomId, url: commons, leadId, addedBy: userId } },
      {
        queue: "ingest-media",
        data: { newsroomId, url: kit.url, sourceUrl: kit.source_url, leadId, addedBy: userId },
      },
    ]);
  });

  it("records a press kit's licence once, with a credit, and freezes it", async () => {
    const terms = { licence: "Press use with credit", terms_url: "https://label.example/press" };
    const bare = await media("https://label.example/press", null);
    expect((await post(`/media/${bare}/licence`, terms)).status).toBe(400);
    const done = await post(`/media/${bare}/licence`, { ...terms, credit: "Photo: Ada / Label" });
    expect(done.status).toBe(200);
    const item = (await done.json()) as { licence_kind: string; credit_line: string };
    expect([item.licence_kind, item.credit_line]).toEqual(["press-kit", "Photo: Ada / Label"]);
    expect((await post(`/media/${bare}/licence`, terms)).status).toBe(409);
    await expect(
      pools.system.query("update media set credit_line = 'Someone else' where id = $1", [bare]),
    ).rejects.toThrow(/licence is recorded/);
    const { rows } = await pools.system.query(
      "select action from audit_log where entity = 'media' and entity_id = $1",
      [bare],
    );
    expect(rows).toEqual([{ action: "record-licence" }]);

    const commons = await media("https://commons.wikimedia.org/wiki/File:X.jpg", "X");
    expect((await post(`/media/${commons}/licence`, terms)).status).toBe(409);
    const list = (await (await app.request(`/desk/newsrooms/${slug}/media`)).json()) as {
      id: string;
    }[];
    // Unlicensed first.
    expect(list[0]?.id).toBe(commons);
  });
});
