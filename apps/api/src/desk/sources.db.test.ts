// Sources in Postgres (D192) on anr_test: the Editor-in-Chief adds, changes and removes sources and
// records their terms; each write is checked by the files' rules, rescheduled and audited.
import { randomBytes } from "node:crypto";
import { createBoss, platformKey } from "@anr/db";
import { createTestNewsroom, testDatabaseUrl, testPools } from "@anr/db/testing";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";

const pools = testPools();
let boss: PgBoss;
let signedIn: string | null = null;
let app: ReturnType<typeof createApp>;
const call = async (
  path: string,
  init: { body?: unknown; method?: string } = {},
): Promise<{ status: number; json: any; text: string }> => {
  const res = await app.request(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
};

const tag = randomBytes(4).toString("hex");
const chief = `chief-${tag}@example.test`;
const editor = `editor-${tag}@example.test`;
let newsroomId = "";
let at = (rest: string) => rest;

beforeAll(async () => {
  boss = createBoss(testDatabaseUrl(process.env.DATABASE_URL ?? ""), "sources-test", {
    schedule: false,
    supervise: false,
  });
  await boss.start();
  app = createApp({
    pool: pools.app,
    boss,
    platform: platformKey(randomBytes(32).toString("base64")),
    verify: async () => signedIn,
    site: { rootDomain: "example.test" },
  });
  newsroomId = await createTestNewsroom(pools.system, "sources");
  const { rows } = await pools.system.query<{ slug: string }>(
    "select slug from newsrooms where id = $1",
    [newsroomId],
  );
  at = (rest: string) => `/desk/newsrooms/${rows[0]?.slug}${rest}`;
  for (const [email, role] of [
    [chief, "editor-in-chief"],
    [editor, "editor"],
  ] as const) {
    const { rows: users } = await pools.system.query<{ id: string }>(
      "insert into users (email) values ($1) returning id",
      [email],
    );
    await pools.system.query(
      "insert into memberships (newsroom_id, user_id, role) values ($1, $2, $3)",
      [newsroomId, users[0]?.id, role],
    );
  }
}, 60_000);
afterAll(async () => {
  await boss.stop({ graceful: false });
  await pools.end();
});

const scheduled = async (sourceId: string) =>
  (await boss.getSchedules("ingest-source")).filter(
    (s) => (s.data as { sourceId?: string }).sourceId === sourceId,
  );

describe("a source through the API", () => {
  it("is added, read, changed and removed by the Editor-in-Chief, rescheduled each time", async () => {
    const feed = {
      id: "example-feed",
      kind: "rss",
      url: "https://example.test/feed.xml",
      publisher: "Example",
      tier: 2,
      every: "6h",
    };
    signedIn = editor;
    expect((await call(at("/sources"), { body: feed })).status).toBe(403);

    signedIn = chief;
    const added = await call(at("/sources"), { body: feed });
    expect(added.status).toBe(201);
    expect(added.json).toMatchObject({ id: "example-feed", every: "6h" });
    const id = added.json.source_id as string;
    // Not fetched until a person has read its terms (D17).
    expect(await scheduled(id)).toEqual([]);
    expect((await call(at("/sources"), { body: feed })).status).toBe(409);
    expect(
      (await call(at("/sources"), { body: { ...feed, id: "x", terms_checked: "2026-11-01" } }))
        .status,
    ).toBe(400);

    const read = await call(at(`/sources/${id}/terms`), {
      body: { read: true, note: "Feed use allowed." },
    });
    expect(read.json).toMatchObject({
      terms_checked: expect.any(String),
      terms_note: "Feed use allowed.",
    });
    expect((await scheduled(id)).map((s) => s.cron)).toEqual(["0 */6 * * *"]);
    const { rows } = await pools.system.query<{ by: string | null }>(
      "select u.email as by from sources s join users u on u.id = s.terms_checked_by where s.id = $1",
      [id],
    );
    expect(rows[0]?.by).toBe(chief);

    const changed = await call(at(`/sources/${id}/edit`), {
      body: { every: "30m", publisher: null },
    });
    expect(changed.json).toMatchObject({ every: "30m" });
    expect(changed.json.publisher).toBeUndefined();
    expect((await scheduled(id)).map((s) => s.cron)).toEqual(["*/30 * * * *"]);

    // The files' own rules: an interval must divide an hour or a day.
    const bad = await call(at(`/sources/${id}/edit`), { body: { every: "45m" } });
    expect(bad.status).toBe(400);
    expect(bad.json.problems.join("\n")).toMatch(/interval 45m/);

    expect((await call(at("/sources/export"))).text).toMatch(/id: example-feed[\s\S]*every: 30m/);

    const removed = await call(at(`/sources/${id}`), { method: "DELETE" });
    expect(removed.json).toMatchObject({ removed: true });
    expect(await scheduled(id)).toEqual([]);

    const audit = (await call(at(`/audit?entity_id=${id}`))).json.map(
      (a: { action: string }) => a.action,
    );
    expect(audit).toEqual(["remove-source", "edit-source", "terms-read", "add-source"]);
  });
});
