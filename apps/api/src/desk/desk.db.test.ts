// The desk API end to end on anr_test: sign-in, memberships, the review queue and every decision.
import { randomBytes } from "node:crypto";
import { openCredentials, platformKey } from "@anr/db";
import { createTestNewsroom, testPools } from "@anr/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";

const pools = testPools();
afterAll(() => pools.end());
const platform = platformKey(randomBytes(32).toString("base64"));
const sent: { queue: string; data: unknown }[] = [];
const boss = { send: async (queue: string, data: object) => (sent.push({ queue, data }), "job") };
let signedIn: string | null = null;
const app = createApp({
  pool: pools.app,
  boss: boss as never,
  platform,
  verify: async () => signedIn,
  site: { rootDomain: "example.test" },
});

const one = async (sql: string, params: unknown[]) =>
  ((await pools.system.query(sql, params)).rows[0] as { id: string }).id;

let newsroomId = "";
let slug = "";
let otherSlug = "";
const chief = `chief-${randomBytes(4).toString("hex")}@example.test`;
const editor = `editor-${randomBytes(4).toString("hex")}@example.test`;
let held = "";
let sibling = "";
let assignmentId = "";
let unknownPost = "";
let sampleId = "";

beforeAll(async () => {
  newsroomId = await createTestNewsroom(pools.system, "desk");
  const other = await createTestNewsroom(pools.system, "desk");
  const slugOf = async (id: string) =>
    (await pools.system.query<{ slug: string }>("select slug from newsrooms where id = $1", [id]))
      .rows[0]?.slug ?? "";
  slug = await slugOf(newsroomId);
  otherSlug = await slugOf(other);
  for (const [email, role] of [
    [chief, "editor-in-chief"],
    [editor, "editor"],
  ] as const) {
    const userId = await one("insert into users (email) values ($1) returning id", [email]);
    await pools.system.query(
      "insert into memberships (newsroom_id, user_id, role) values ($1, $2, $3)",
      [newsroomId, userId, role],
    );
  }
  const seriesId = await one(
    `insert into series (newsroom_id, slug, format_id, languages, config)
     select $1, 'daily-newsletter', f.id, '{fa,en}', '{}' from formats f where f.slug = 'newsletter-issue' returning id`,
    [newsroomId],
  );
  const slot = new Date("2026-10-27T18:00:00Z");
  assignmentId = await one(
    "insert into assignments (newsroom_id, series_id, slot) values ($1, $2, $3) returning id",
    [newsroomId, seriesId, slot],
  );
  const storyId = await one(
    "insert into stories (newsroom_id, assignment_id) values ($1, $2) returning id",
    [newsroomId, assignmentId],
  );
  const claimId = await one(
    `insert into claims (newsroom_id, story_id, ref, kind, text) values ($1, $2, 'c1', 'opinion', 'An opinion.') returning id`,
    [newsroomId, storyId],
  );
  const publication = async (language: string) => {
    const renditionId = await one(
      `insert into renditions (newsroom_id, story_id, format_id, language, body)
       select $1, $2, f.id, $3, '{"title": "Held issue", "items": []}' from formats f where f.slug = 'newsletter-issue' returning id`,
      [newsroomId, storyId, language],
    );
    const id = await one(
      `insert into publications (newsroom_id, series_id, assignment_id, slot, language, status)
       values ($1, $2, $3, $4, $5, 'with-editor') returning id`,
      [newsroomId, seriesId, assignmentId, slot, language],
    );
    await pools.system.query(
      "insert into publication_renditions (newsroom_id, publication_id, position, rendition_id) values ($1, $2, 1, $3)",
      [newsroomId, id, renditionId],
    );
    await pools.system.query(
      `insert into checks (newsroom_id, rendition_id, kind, name, result) values ($1, $2, 'code', 'schema', 'pass')`,
      [newsroomId, renditionId],
    );
    return id;
  };
  held = await publication("fa");
  sibling = await publication("en");
  await pools.system.query(
    `insert into checks (newsroom_id, claim_id, kind, name, result, detail)
     values ($1, $2, 'fact-check', 'fact-check', 'partial', '{"reason": "date differs"}')`,
    [newsroomId, claimId],
  );
  const channelId = await one(
    "insert into channels (newsroom_id, kind, language, external_id) values ($1, 'telegram', 'fa', '@x') returning id",
    [newsroomId],
  );
  unknownPost = await one(
    `insert into posts (newsroom_id, publication_id, channel_id, part, idempotency_key, body, status)
     values ($1, $2, $3, 1, $4, 'text', 'unknown') returning id`,
    [newsroomId, held, channelId, `k-${held}`],
  );
  const published = await one(
    `insert into publications (newsroom_id, series_id, slot, language, status, published_at, title)
     values ($1, $2, '2026-10-26T18:00:00Z', 'fa', 'published', now(), 'Out already') returning id`,
    [newsroomId, seriesId],
  );
  sampleId = await one(
    "insert into sample_reviews (newsroom_id, publication_id) values ($1, $2) returning id",
    [newsroomId, published],
  );
  await pools.system.query(
    "insert into notices (newsroom_id, kind, key) values ($1, 'no-channel', 'telegram:en')",
    [newsroomId],
  );
});

const call = async (
  path: string,
  init: { method?: string; body?: unknown; as?: string | null } = {},
) => {
  signedIn = init.as === undefined ? chief : init.as;
  const res = await app.request(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, json: (await res.json()) as any };
};
const at = (rest: string) => `/desk/newsrooms/${slug}${rest}`;
const version = async (id: string) =>
  (
    await pools.system.query<{ v: string }>(
      "select updated_at::text as v from publications where id = $1",
      [id],
    )
  ).rows[0]?.v as string;

describe("desk sign-in and memberships", () => {
  it("refuses anyone not signed in, or signed in without a user", async () => {
    expect((await call("/desk/me", { as: null })).status).toBe(401);
    expect((await call("/desk/me", { as: "stranger@example.test" })).status).toBe(401);
  });

  it("lists the person's memberships", async () => {
    const me = await call("/desk/me", { as: editor.toUpperCase() });
    expect(me.status).toBe(200);
    expect(me.json.memberships).toEqual([
      expect.objectContaining({ newsroom: slug, role: "editor" }),
    ]);
  });

  it("keeps a member out of other newsrooms", async () => {
    expect((await call(`/desk/newsrooms/${otherSlug}/queue`)).status).toBe(403);
  });
});

describe("review queue and decisions", () => {
  it("shows held publications with every check that did not pass", async () => {
    const q = await call(at("/queue"), { as: editor });
    expect(q.status).toBe(200);
    const item = q.json.find((x: { id: string }) => x.id === held);
    expect(item).toMatchObject({ title: "Held issue", unknown_posts: 1, language: "fa" });
    expect(
      item.holds.map((h: { name: string; result: string; claim: string }) => [
        h.name,
        h.result,
        h.claim,
      ]),
    ).toEqual([["fact-check", "partial", "c1"]]);
  });

  it("shows one publication with its claims, checks and posts", async () => {
    const p = await call(at(`/publications/${held}`), { as: editor });
    expect(p.status).toBe(200);
    expect(p.json.claims).toEqual([expect.objectContaining({ ref: "c1", kind: "opinion" })]);
    expect(p.json.posts).toEqual([expect.objectContaining({ status: "unknown", part: 1 })]);
    expect((await call(at("/publications/not-a-uuid"))).status).toBe(404);
  });

  it("will not approve while a post's result is unknown", async () => {
    const r = await call(at(`/publications/${held}/approve`), {
      body: { version: await version(held) },
      as: editor,
    });
    expect(r.status).toBe(409);
  });

  it("settles an unknown post, then approves, with a person in the audit log", async () => {
    const resolved = await call(at(`/posts/${unknownPost}/resolve`), {
      body: { went_out: true, external_id: "77" },
      as: editor,
    });
    expect(resolved.json).toEqual({ id: unknownPost, status: "sent" });
    const ok = await call(at(`/publications/${held}/approve`), {
      body: { version: await version(held) },
      as: editor,
    });
    expect(ok.json).toEqual({ id: held, status: "scheduled" });
    const { rows } = await pools.system.query(
      "select actor_kind, action from audit_log where entity_id = $1 order by at",
      [held],
    );
    expect(rows).toEqual([
      { actor_kind: "person", action: "open" },
      { actor_kind: "person", action: "approve" },
    ]);
    expect(
      (await call(at(`/publications/${held}/approve`), { body: { version: await version(held) } }))
        .status,
    ).toBe(409);
  });

  it("returns an assignment to the desk with a note and queues the re-draft", async () => {
    expect(
      (await call(at(`/publications/${sibling}/return`), { body: { note: " " } })).status,
    ).toBe(400);
    const r = await call(at(`/publications/${sibling}/return`), {
      body: { note: "Use the lab's own post." },
    });
    expect(r.json).toEqual({ id: sibling, status: "assigned" });
    const { rows } = await pools.system.query("select status from publications where id = $1", [
      sibling,
    ]);
    expect(rows[0]?.status).toBe("assigned");
    expect(sent.at(-1)).toEqual({ queue: "redraft", data: { newsroomId, assignmentId } });
    const { rows: audit } = await pools.system.query(
      "select after from audit_log where entity = 'assignments' and entity_id = $1",
      [assignmentId],
    );
    expect(audit[0]?.after).toMatchObject({ note: "Use the lab's own post." });
  });
});

describe("channels", () => {
  it("lets only the Editor-in-Chief add one, and checks what it needs", async () => {
    const telegram = {
      kind: "telegram",
      language: "fa",
      external_id: "@anr_fa",
      credentials: { bot_token: "123:SECRET-TOKEN" },
    };
    expect((await call(at("/channels"), { body: telegram, as: editor })).status).toBe(403);
    expect((await call(at("/channels"), { body: { ...telegram, credentials: {} } })).status).toBe(
      400,
    );
    expect((await call(at("/channels"), { body: { ...telegram, kind: "fax" } })).status).toBe(400);
  });

  it("seals the credentials and never returns or audits them", async () => {
    const added = await call(at("/channels"), {
      body: {
        kind: "telegram",
        language: "fa",
        external_id: "@anr_fa",
        credentials: { bot_token: "123:SECRET-TOKEN" },
      },
    });
    expect(added.status).toBe(201);
    expect(added.json).toMatchObject({ kind: "telegram", has_credentials: true, status: "active" });
    expect(JSON.stringify(added.json)).not.toContain("SECRET");
    const list = await call(at("/channels"), { as: editor });
    expect(JSON.stringify(list.json)).not.toContain("SECRET");
    const { rows } = await pools.system.query<{ credentials: Buffer }>(
      "select credentials from channels where id = $1",
      [added.json.id],
    );
    expect(rows[0]?.credentials.toString("latin1")).not.toContain("SECRET");
    expect(
      openCredentials(
        rows[0]?.credentials as Buffer,
        { newsroomId, channelId: added.json.id },
        platform,
      ),
    ).toEqual({
      bot_token: "123:SECRET-TOKEN",
    });
    const off = await call(at(`/channels/${added.json.id}/status`), {
      body: { status: "disabled" },
    });
    expect(off.json.status).toBe("disabled");
    const { rows: audit } = await pools.system.query(
      "select before, after from audit_log where entity = 'channels' and entity_id = $1",
      [added.json.id],
    );
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain("SECRET");
  });
});

describe("samples and notices", () => {
  it("records a miss only with a note, once", async () => {
    expect(
      (await call(at(`/samples/${sampleId}/review`), { body: { outcome: "miss" }, as: editor }))
        .status,
    ).toBe(400);
    const r = await call(at(`/samples/${sampleId}/review`), {
      body: { outcome: "miss", note: "A date was wrong; check dates against the passage." },
      as: editor,
    });
    expect(r.json).toMatchObject({ outcome: "miss", title: "Out already" });
    expect(
      (await call(at(`/samples/${sampleId}/review`), { body: { outcome: "ok" } })).status,
    ).toBe(409);
  });

  it("lists and reads notices", async () => {
    const list = await call(at("/notices"));
    expect(list.json).toEqual([expect.objectContaining({ kind: "no-channel", read_at: null })]);
    await call(at(`/notices/${list.json[0].id}/read`), { method: "POST" });
    expect((await call(at("/notices"))).json[0].read_at).not.toBeNull();
  });
});
