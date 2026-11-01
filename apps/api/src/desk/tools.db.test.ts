// The desk's tools on anr_test: preview, edit, pull-back, schedule, channel checks and tokens,
// filed misses, budget, sources and measures. The preview is held to what the publisher sends.
import { randomBytes } from "node:crypto";
import { openCredentials, platformKey, sealCredentials } from "@anr/db";
import { createTestNewsroom, testPools } from "@anr/db/testing";
import type { ChannelAdapter } from "@anr/publisher/publish";
import { publishOne } from "@anr/publisher/publish";
import { createRenderer } from "@anr/render";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";

const pools = testPools();
afterAll(() => pools.end());
const platform = platformKey(randomBytes(32).toString("base64"));
const renderer = createRenderer();
const site = { rootDomain: "example.test" };
const sent: { queue: string; data: unknown }[] = [];
const boss = { send: async (queue: string, data: object) => (sent.push({ queue, data }), "job") };
let signedIn: string | null = null;
const app = createApp({
  pool: pools.app,
  boss: boss as never,
  platform,
  verify: async () => signedIn,
  site,
  renderer,
});

const one = async (sql: string, params: unknown[]) =>
  ((await pools.system.query(sql, params)).rows[0] as { id: string }).id;

const chief = `chief-${randomBytes(4).toString("hex")}@example.test`;
const editor = `editor-${randomBytes(4).toString("hex")}@example.test`;
let newsroomId = "";
let slug = "";
let seriesId = "";
let telegramId = "";
let slots = 0;

beforeAll(async () => {
  newsroomId = await createTestNewsroom(pools.system, "tools");
  slug = (
    await pools.system.query<{ slug: string }>("select slug from newsrooms where id = $1", [
      newsroomId,
    ])
  ).rows[0]?.slug as string;
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
  seriesId = await one(
    `insert into series (newsroom_id, slug, format_id, languages, config)
     select $1, 'daily-newsletter', f.id, '{en}',
            '{"cadence": {"daily": "21:00"}, "channels": {"site": ["en"], "telegram": ["en"]}}'
     from formats f where f.slug = 'newsletter-issue' returning id`,
    [newsroomId],
  );
  telegramId = await one(
    `insert into channels (newsroom_id, kind, language, external_id)
     values ($1, 'telegram', 'en', '@anr_test') returning id`,
    [newsroomId],
  );
  await pools.system.query("update channels set credentials = $2 where id = $1", [
    telegramId,
    sealCredentials({ bot_token: "123:OLD" }, { newsroomId, channelId: telegramId }, platform),
  ]);
});

/** A publication in `status` with a three-item newsletter, each slot its own day in the past. */
async function issue(status = "with-editor", slot?: Date) {
  slots += 1;
  const at = slot ?? new Date(Date.UTC(2001, 0, slots, 18));
  const assignmentId = await one(
    "insert into assignments (newsroom_id, series_id, slot) values ($1, $2, $3) returning id",
    [newsroomId, seriesId, at],
  );
  const storyId = await one(
    "insert into stories (newsroom_id, assignment_id) values ($1, $2) returning id",
    [newsroomId, assignmentId],
  );
  const items = [1, 2, 3].map((i) => ({
    kind: "news",
    headline: `Item ${i}`,
    body: `Body of item ${i}.`,
    claim_ids: ["c1"],
  }));
  const renditionId = await one(
    `insert into renditions (newsroom_id, story_id, format_id, language, body)
     select $1, $2, f.id, 'en', $3 from formats f where f.slug = 'newsletter-issue' returning id`,
    [newsroomId, storyId, JSON.stringify({ language: "en", title: "Today in AI", items })],
  );
  const id = await one(
    `insert into publications (newsroom_id, series_id, assignment_id, slot, language, status)
     values ($1, $2, $3, $4, 'en', $5) returning id`,
    [newsroomId, seriesId, assignmentId, at, status],
  );
  await pools.system.query(
    "insert into publication_renditions (newsroom_id, publication_id, position, rendition_id) values ($1, $2, 1, $3)",
    [newsroomId, id, renditionId],
  );
  return { id, renditionId };
}

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

/** The version the desk page shows for a publication. */
const version = async (id: string) =>
  (
    await pools.system.query<{ v: string }>(
      "select updated_at::text as v from publications where id = $1",
      [id],
    )
  ).rows[0]?.v as string;

/** Approves through the desk, then publishes with a fake Telegram; returns what it sent. */
async function approveAndPublish(id: string) {
  const approved = await call(at(`/publications/${id}/approve`), {
    body: { version: await version(id) },
  });
  expect(approved.status).toBe(200);
  const texts: string[] = [];
  const adapter: ChannelAdapter = {
    send: async (_t, text) => (texts.push(text), String(texts.length)),
  };
  const slot = (
    await pools.system.query<{ slot: Date }>("select slot from publications where id = $1", [id])
  ).rows[0]?.slot as Date;
  const outcome = await publishOne(
    {
      pool: pools.app,
      renderer,
      adapters: { telegram: adapter },
      platform,
      rootDomain: site.rootDomain,
      live: true,
      // At its slot: the fixtures' slots are in 2001, long past any grace (D129).
      now: () => slot,
    },
    newsroomId,
    id,
  );
  expect(outcome).toBe("published");
  return texts;
}

describe("preview", () => {
  it("is exactly what the publisher sends", async () => {
    const { id } = await issue();
    const preview = await call(at(`/publications/${id}/preview`), { as: editor });
    expect(preview.status).toBe(200);
    expect(preview.json).toMatchObject({ edited: false, label: expect.any(String) });
    const telegram = preview.json.channels.find((c: { kind: string }) => c.kind === "telegram");
    expect(telegram).toMatchObject({ configured: true });
    expect(telegram.parts[0]).toContain(preview.json.label);
    expect(preview.json.site.html).toContain("Body of item 2.");
    expect(preview.json.site.url).toMatch(/^https:\/\/.*example\.test\/daily-newsletter\//);
    expect(await approveAndPublish(id)).toEqual(telegram.parts);
  });
});

describe("editing a held publication", () => {
  it("changes only text, keeps the format's schema, and is what goes out", async () => {
    const { id, renditionId } = await issue();
    const before = (await call(at(`/publications/${id}/preview`))).json;
    const edit = async (changes: unknown, as = editor) =>
      call(at(`/publications/${id}/edit`), { body: { version: await version(id), changes }, as });
    expect((await edit([{ pointer: "/items/0/claim_ids/0", text: "c9" }])).status).toBe(400);
    expect((await edit([{ pointer: "/items/7/body", text: "x" }])).status).toBe(400);
    const empty = await edit([{ pointer: "/title", text: "" }]);
    expect(empty.status).toBe(400);
    expect(empty.json.error).toMatch(/no longer fits the format/);
    expect((await edit([{ pointer: "/items/1/body", text: "A person's words." }])).status).toBe(
      200,
    );
    const { rows: audit } = await pools.system.query(
      "select actor_kind, action from audit_log where entity = 'renditions' and entity_id = $1",
      [renditionId],
    );
    expect(audit).toEqual([{ actor_kind: "person", action: "edit" }]);

    const after = (await call(at(`/publications/${id}/preview`))).json;
    expect(after.edited).toBe(true);
    expect(after.label).not.toBe(before.label);
    const parts = after.channels.find((c: { kind: string }) => c.kind === "telegram").parts;
    expect(parts.join("\n")).toContain("A person&#39;s words.");
    expect(parts.every((p: string) => p.includes(after.label))).toBe(true);
    expect(await approveAndPublish(id)).toEqual(parts);
    const { rows } = await pools.system.query("select edited from publications where id = $1", [
      id,
    ]);
    expect(rows[0]?.edited).toBe(true);
  });

  it("is refused once a part has gone out, or for a publication not held", async () => {
    const { id } = await issue();
    await pools.system.query(
      `insert into posts (newsroom_id, publication_id, channel_id, part, idempotency_key, body, status)
       values ($1, $2, $3, 1, $4, 'x', 'sent')`,
      [newsroomId, id, telegramId, `k-${id}`],
    );
    const change = async (p: string) => ({
      version: await version(p),
      changes: [{ pointer: "/title", text: "New" }],
    });
    expect((await call(at(`/publications/${id}/edit`), { body: await change(id) })).status).toBe(
      409,
    );
    const scheduled = await issue("scheduled");
    expect(
      (await call(at(`/publications/${scheduled.id}/edit`), { body: await change(scheduled.id) }))
        .status,
    ).toBe(409);
    // Pulled back mid-send: a part whose call started may still go out with the old text.
    const inFlight = await issue();
    await pools.system.query(
      `insert into posts (newsroom_id, publication_id, channel_id, part, idempotency_key, body, status, attempted_at)
       values ($1, $2, $3, 1, $4, 'x', 'pending', now())`,
      [newsroomId, inFlight.id, telegramId, `k-${inFlight.id}`],
    );
    const page = await call(at(`/publications/${inFlight.id}`));
    expect(page.json.editable).toBe(false);
    expect(
      (await call(at(`/publications/${inFlight.id}/edit`), { body: await change(inFlight.id) }))
        .status,
    ).toBe(409);
  });

  it("refuses an approval or edit of text the editor did not see", async () => {
    const { id } = await issue();
    const seen = (await call(at(`/publications/${id}`), { as: editor })).json.version;
    const edited = await call(at(`/publications/${id}/edit`), {
      body: { version: seen, changes: [{ pointer: "/title", text: "Chief's title" }] },
    });
    expect(edited.status).toBe(200);
    const stale = await call(at(`/publications/${id}/approve`), {
      body: { version: seen },
      as: editor,
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error).toMatch(/changed since you opened it/);
    const again = await call(at(`/publications/${id}/edit`), {
      body: { version: seen, changes: [{ pointer: "/title", text: "Mine" }] },
      as: editor,
    });
    expect(again.status).toBe(409);
    expect((await call(at(`/publications/${id}/approve`), { body: {} })).status).toBe(400);
  });
});

describe("schedule and pull-back", () => {
  it("lists upcoming slots and pulls a scheduled one back to the queue with its reason", async () => {
    const soon = await issue("scheduled", new Date(Date.now() + 3 * 3600_000));
    const later = await issue("scheduled", new Date(Date.now() + 20 * 86400_000));
    const upcoming = await call(at("/schedule"), { as: editor });
    const ids = upcoming.json.map((p: { id: string }) => p.id);
    expect(ids).toContain(soon.id);
    expect(ids).not.toContain(later.id);
    expect((await call(at("/schedule?days=40"))).status).toBe(400);

    const pull = (id: string, note?: string) =>
      call(at(`/publications/${id}/pull-back`), { body: { note }, as: editor });
    expect((await pull(soon.id)).status).toBe(400);
    expect((await pull(soon.id, "Wait for the lab's correction.")).json).toEqual({
      id: soon.id,
      status: "with-editor",
    });
    expect((await pull(soon.id, "again")).status).toBe(409);
    const queue = await call(at("/queue"));
    const item = queue.json.find((x: { id: string }) => x.id === soon.id);
    expect(item.holds).toEqual([
      expect.objectContaining({
        name: "pulled-back",
        detail: { note: "Wait for the lab's correction." },
      }),
    ]);
    const { rows } = await pools.system.query(
      "select action from audit_log where entity_id = $1 and actor_kind = 'person'",
      [soon.id],
    );
    expect(rows).toEqual([{ action: "pull-back" }]);
  });
});

describe("opening a held publication", () => {
  it("is recorded once per person within ten minutes", async () => {
    const { id } = await issue();
    await call(at(`/publications/${id}`), { as: editor });
    await call(at(`/publications/${id}`), { as: editor });
    await call(at(`/publications/${id}`), { as: chief });
    const { rows } = await pools.system.query<{ n: number }>(
      "select count(*)::int as n from audit_log where entity_id = $1 and action = 'open'",
      [id],
    );
    expect(rows[0]?.n).toBe(2);
    const scheduled = await issue("scheduled");
    await call(at(`/publications/${scheduled.id}`));
    const { rows: none } = await pools.system.query(
      "select 1 from audit_log where entity_id = $1 and action = 'open'",
      [scheduled.id],
    );
    expect(none).toHaveLength(0);
  });
});

describe("channels: test and replace the token", () => {
  it("queues a check for the publisher, for the Editor-in-Chief only", async () => {
    expect(
      (await call(at(`/channels/${telegramId}/check`), { method: "POST", as: editor })).status,
    ).toBe(403);
    const r = await call(at(`/channels/${telegramId}/check`), { method: "POST" });
    expect(r.json).toEqual({ id: telegramId, status: "check-queued" });
    expect(sent.at(-1)).toEqual({
      queue: "channel-check",
      data: { newsroomId, channelId: telegramId },
    });
  });

  it("re-seals a new token to the same channel, audits it redacted, and checks it", async () => {
    await pools.system.query(
      `update channels set checked_at = now(), check_result = '{"ok": true}' where id = $1`,
      [telegramId],
    );
    const replace = (credentials: unknown, as = chief) =>
      call(at(`/channels/${telegramId}/credentials`), { body: { credentials }, as });
    expect((await replace({ bot_token: "123:NEW-SECRET" }, editor)).status).toBe(403);
    expect((await replace({ other: "x" })).status).toBe(400);
    const r = await replace({ bot_token: " 123:NEW-SECRET " });
    expect(r.json).toMatchObject({ id: telegramId, has_credentials: true, check_result: null });
    expect(JSON.stringify(r.json)).not.toContain("SECRET");
    const { rows } = await pools.system.query<{ credentials: Buffer }>(
      "select credentials from channels where id = $1",
      [telegramId],
    );
    expect(
      openCredentials(
        rows[0]?.credentials as Buffer,
        { newsroomId, channelId: telegramId },
        platform,
      ),
    ).toEqual({ bot_token: "123:NEW-SECRET" });
    const { rows: audit } = await pools.system.query(
      "select before, after from audit_log where entity_id = $1 and action = 'replace-credentials'",
      [telegramId],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.after.credentials).toBe("[redacted]");
    expect(JSON.stringify(audit)).not.toMatch(/SECRET|OLD/);
    expect(sent.at(-1)?.queue).toBe("channel-check");
  });
});

describe("a sample miss filed as an issue", () => {
  it("records the issue's URL on a miss only", async () => {
    const published = await issue("published");
    const sample = async (outcome: string, note: string | null) =>
      one(
        `insert into sample_reviews (newsroom_id, publication_id, outcome, note, reviewed_at)
         values ($1, $2, $3, $4, now()) returning id`,
        [newsroomId, published.id, outcome, note],
      );
    const miss = await sample("miss", "The date was wrong.");
    const file = (id: string, url: string) =>
      call(at(`/samples/${id}/issue`), { body: { url }, as: editor });
    expect((await file(miss, "javascript:alert(1)")).status).toBe(400);
    const r = await file(miss, "https://github.com/example/anr/issues/12");
    expect(r.json).toMatchObject({
      issue_url: "https://github.com/example/anr/issues/12",
      filed_at: expect.any(String),
    });
    await pools.system.query("delete from sample_reviews where id = $1", [miss]);
    const fine = await sample("ok", null);
    expect((await file(fine, "https://github.com/example/anr/issues/13")).status).toBe(409);
  });
});

describe("budget, sources and measures", () => {
  /** A fresh newsroom, so its numbers are only this test's. */
  async function measured() {
    const id = await createTestNewsroom(pools.system, "measures");
    const s = (
      await pools.system.query<{ slug: string }>("select slug from newsrooms where id = $1", [id])
    ).rows[0]?.slug as string;
    const userId = await one("select id from users where email = $1", [chief]);
    await pools.system.query(
      "insert into memberships (newsroom_id, user_id, role) values ($1, $2, 'editor-in-chief')",
      [id, userId],
    );
    return { id, s, userId };
  }

  it("shows this month's spend against the budget, by role", async () => {
    const n = await measured();
    for (const [role, cost] of [
      ["desk", 1.5],
      ["fact-checker", 0.25],
      ["desk", 0.5],
    ] as const)
      await pools.system.query(
        `insert into agent_runs (newsroom_id, role, provider, model, prompt_version, input_hash, cost_usd, outcome)
         values ($1, $2, 'test', 'm', 'v1', 'h', $3, 'submitted')`,
        [n.id, role, cost],
      );
    const b = await call(`/desk/newsrooms/${n.s}/budget`);
    expect(b.json).toMatchObject({
      monthly_usd: 1000,
      writing_limit_usd: 1000,
      spent_usd: 2.25,
      by_role: [
        { role: "desk", runs: 2, cost_usd: 2 },
        { role: "fact-checker", runs: 1, cost_usd: 0.25 },
      ],
    });
    expect(b.json.runs).toHaveLength(3);
  });

  it("lists failing sources first, with their recent leads", async () => {
    const n = await measured();
    const source = async (slugName: string, terms: string | null) =>
      one(
        `insert into sources (newsroom_id, slug, kind, url, tier, fetch_every, terms_checked)
         values ($1, $2, 'rss', 'https://example.test/feed', 2, '1 hour', $3) returning id`,
        [n.id, slugName, terms],
      );
    const healthy = await source("healthy", "2026-10-01");
    const failing = await source("failing", "2026-10-01");
    await pools.system.query(
      `insert into source_fetch_state (newsroom_id, source_id, last_fetched_at, last_status, last_error, consecutive_failures)
       values ($1, $2, now(), 503, 'HTTP 503', 4), ($1, $3, now(), 200, null, 0)`,
      [n.id, failing, healthy],
    );
    await pools.system.query(
      `insert into leads (newsroom_id, source_id, uri, body, language, content_hash, tier)
       values ($1, $2, 'https://example.test/a', 'text', 'en', 'h1', 2)`,
      [n.id, healthy],
    );
    const list = await call(`/desk/newsrooms/${n.s}/sources`);
    expect(list.json.map((x: { slug: string }) => x.slug)).toEqual(["failing", "healthy"]);
    expect(list.json[0]).toMatchObject({ last_status: 503, consecutive_failures: 4, leads_7d: 0 });
    expect(list.json[1]).toMatchObject({ leads_7d: 1, terms_checked: "2026-10-01" });
  });

  it("measures holds, misses, minutes, cost and audience by week", async () => {
    const n = await measured();
    const series = await one(
      `insert into series (newsroom_id, slug, format_id, languages, config)
       select $1, 'daily-newsletter', f.id, '{en}', '{}' from formats f where f.slug = 'newsletter-issue' returning id`,
      [n.id],
    );
    const pub = async (minutes: number, status: string, published: boolean) =>
      one(
        `insert into publications (newsroom_id, series_id, slot, language, status, published_at)
         values ($1, $2, now() - make_interval(mins => $3), 'en', $4, case when $5 then now() end)
         returning id`,
        [n.id, series, minutes, status, published],
      );
    const a = await pub(1, "published", true);
    const b = await pub(2, "with-editor", false);
    const c = await pub(3, "published", true);
    await pub(4, "drafted", false);
    const check = (p: string, name: string, result: string) =>
      pools.system.query(
        `insert into checks (newsroom_id, publication_id, kind, name, result) values ($1, $2, 'policy', $3, $4)`,
        [n.id, p, name, result],
      );
    await check(a, "restricted-beat", "fail");
    await check(b, "pulled-back", "fail");
    await check(c, "deadline", "pass");
    await pools.system.query(
      `insert into agent_runs (newsroom_id, role, provider, model, prompt_version, input_hash, cost_usd)
       values ($1, 'desk', 'test', 'm', 'v1', 'h', 3)`,
      [n.id],
    );
    await pools.system.query(
      `insert into page_views (newsroom_id, publication_id, day, count)
       values ($1, $2, (now() at time zone 'UTC')::date, 5)`,
      [n.id, a],
    );
    await pools.system.query(
      `insert into sample_reviews (newsroom_id, publication_id, outcome, note, reviewed_at)
       values ($1, $2, 'miss', 'x', now())`,
      [n.id, c],
    );
    const audit = (action: string, minutesAgo: number) =>
      pools.system.query(
        `insert into audit_log (newsroom_id, actor_kind, actor_user_id, action, entity, entity_id, at)
         values ($1, 'person', $2, $3, 'publications', $4, now() - make_interval(mins => $5))`,
        [n.id, n.userId, action, a, minutesAgo],
      );
    await audit("open", 95); // outside the window of the decision below
    await audit("open", 12);
    await audit("open", 5);
    await audit("approve", 2);

    const m = await call(`/desk/newsrooms/${n.s}/measures?weeks=2`);
    expect(m.status).toBe(200);
    expect(m.json.weeks).toHaveLength(2);
    const sum = (k: string) =>
      m.json.weeks.reduce((t: number, w: Record<string, number>) => t + (w[k] ?? 0), 0);
    expect(sum("published")).toBe(2);
    expect(sum("gated")).toBe(3);
    expect(sum("held")).toBe(1);
    expect(sum("sample_misses")).toBe(1);
    expect(sum("cost_usd")).toBe(3);
    expect(sum("editor_minutes")).toBeCloseTo(10, 0);
    const week = m.json.weeks.find((w: { published: number }) => w.published > 0);
    expect(week).toMatchObject({ cost_per_publication: 1.5, page_views: { en: 5 } });
    expect(week.hold_rate).toBeCloseTo(1 / 3);
    expect((await call(`/desk/newsrooms/${n.s}/measures?weeks=0`)).status).toBe(400);
  });
});
