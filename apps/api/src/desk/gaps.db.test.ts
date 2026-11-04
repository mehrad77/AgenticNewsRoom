// What the desk could only do on the host before (D190), on anr_test: people, the audit log,
// agent runs, leads, fetching a source now, notices since, host status and the admin's hand-over.
import { randomBytes } from "node:crypto";
import { QUEUES } from "@anr/core";
import { platformKey } from "@anr/db";
import { createTestNewsroom, testPools } from "@anr/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { holdPlatformAdmin } from "../../test/platform-admin.ts";
import { createApp } from "../app.ts";

const pools = testPools();
let releaseAdmin: () => Promise<void> = async () => {};
afterAll(async () => {
  await releaseAdmin();
  await pools.end();
});
const sent: { queue: string; data: unknown }[] = [];
let signedIn: string | null = null;
const app = createApp({
  pool: pools.app,
  boss: {
    send: async (queue: string, data: object) => {
      sent.push({ queue, data });
      return "job";
    },
  } as never,
  platform: platformKey(randomBytes(32).toString("base64")),
  verify: async () => signedIn,
  site: { rootDomain: "example.test" },
});
const call = async (
  path: string,
  init: { body?: unknown; method?: string; token?: string } = {},
): Promise<{ status: number; json: any }> => {
  const res = await app.request(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      "content-type": "application/json",
      ...(init.token && { authorization: `Bearer ${init.token}` }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, json: await res.json() };
};

const tag = randomBytes(4).toString("hex");
const chief = `chief-${tag}@example.test`;
const editor = `editor-${tag}@example.test`;
let newsroomId = "";
let at = (rest: string) => rest;
const ids: Record<string, string> = {};

beforeAll(async () => {
  releaseAdmin = await holdPlatformAdmin(pools.system);
  newsroomId = await createTestNewsroom(pools.system, "gaps");
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
    ids[email] = users[0]?.id ?? "";
    await pools.system.query(
      "insert into memberships (newsroom_id, user_id, role) values ($1, $2, $3)",
      [newsroomId, ids[email], role],
    );
  }
}, 60_000);

describe("people", () => {
  it("are added, changed and removed by the Editor-in-Chief, audited", async () => {
    signedIn = editor;
    expect(
      (await call(at("/members"), { body: { email: "x@example.test", role: "editor" } })).status,
    ).toBe(403);
    expect((await call(at("/members"))).json).toHaveLength(2);

    signedIn = chief;
    const newcomer = `new-${tag}@Example.test`;
    const added = await call(at("/members"), { body: { email: newcomer, role: "editor" } });
    expect(added.status).toBe(201);
    expect(added.json).toMatchObject({ email: newcomer.toLowerCase(), role: "editor" });
    expect((await call(at("/members"), { body: { email: newcomer, role: "editor" } })).status).toBe(
      409,
    );

    const promoted = await call(at(`/members/${added.json.user_id}/role`), {
      body: { role: "editor-in-chief" },
    });
    expect(promoted.json.role).toBe("editor-in-chief");
    const removed = await call(at(`/members/${added.json.user_id}`), { method: "DELETE" });
    expect(removed.json).toEqual({ user_id: added.json.user_id, removed: true });

    // The last Editor-in-Chief stays.
    expect(
      (await call(at(`/members/${ids[chief]}/role`), { body: { role: "editor" } })).status,
    ).toBe(409);
    expect((await call(at(`/members/${ids[chief]}`), { method: "DELETE" })).status).toBe(409);

    // Removed from every newsroom, their token stops working.
    const { json: leaver } = await call(at("/members"), {
      body: { email: `leaver-${tag}@example.test`, role: "editor" },
    });
    const leaverToken = `anr_${randomBytes(32).toString("base64url")}`;
    await pools.system.query(
      "insert into personal_tokens (user_id, name, token_hash, expires_at) values ($1, 't', sha256($2::bytea), now() + interval '1 day')",
      [leaver.user_id, leaverToken],
    );
    signedIn = null;
    expect((await call("/desk/me", { token: leaverToken })).status).toBe(200);
    signedIn = chief;
    await call(at(`/members/${leaver.user_id}`), { method: "DELETE" });
    signedIn = null;
    expect((await call("/desk/me", { token: leaverToken })).status).toBe(401);
    signedIn = chief;

    const audit = await call(at(`/audit?person=${encodeURIComponent(chief)}&entity=memberships`));
    expect(audit.json.map((a: { action: string }) => a.action)).toEqual([
      "remove-member",
      "add-member",
      "remove-member",
      "set-role",
      "add-member",
    ]);
  });
});

describe("the audit log", () => {
  it("names the token an act came through, and filters by it", async () => {
    signedIn = chief;
    const { json: issued } = await call("/desk/me/tokens", { body: { name: "agent" } });
    signedIn = null;
    const other = `other-${tag}@example.test`;
    await call(at("/members"), { token: issued.token, body: { email: other, role: "editor" } });
    signedIn = chief;
    const entries = (await call(at(`/audit?token=${issued.id}`))).json;
    expect(entries).toEqual([
      expect.objectContaining({
        action: "add-member",
        person: chief,
        token_id: issued.id,
        token_name: "agent",
      }),
    ]);
    expect((await call(at("/audit?limit=0"))).status).toBe(400);
    expect((await call(at("/audit?token=nope"))).status).toBe(400);
  });
});

describe("agent runs and leads", () => {
  it("are listed with their filters", async () => {
    const { rows } = await pools.system.query<{ id: string }>(
      `insert into agent_runs (newsroom_id, role, provider, model, prompt_version, input_hash, outcome, finished_at)
       values ($1, 'summariser', 'lmstudio', 'gemma', 'v1', 'h', 'error', now()) returning id`,
      [newsroomId],
    );
    signedIn = editor;
    const runs = (await call(at("/agent-runs?role=summariser&outcome=error"))).json;
    expect(runs.map((r: { id: string }) => r.id)).toContain(rows[0]?.id);
    expect((await call(at(`/agent-runs/${rows[0]?.id}`))).json).toMatchObject({
      model: "gemma",
      outcome: "error",
    });
    expect((await call(at("/agent-runs?role=writer"))).status).toBe(400);
    expect((await call(at("/leads?limit=5"))).status).toBe(200);
  });
});

describe("fetching a source now", () => {
  it("queues it once its terms are read, audited", async () => {
    const source = async (terms: string | null) =>
      (
        await pools.system.query<{ id: string }>(
          `insert into sources (newsroom_id, slug, kind, url, tier, fetch_every, terms_checked)
           values ($1, $2, 'rss', 'https://example.test/feed', 2, '1 hour', $3) returning id`,
          [newsroomId, `src-${randomBytes(3).toString("hex")}`, terms],
        )
      ).rows[0]?.id as string;
    signedIn = editor;
    const unread = await source(null);
    expect((await call(at(`/sources/${unread}/fetch`), { body: {} })).status).toBe(409);
    const read = await source("2026-11-01");
    sent.length = 0;
    const res = await call(at(`/sources/${read}/fetch`), { body: {} });
    expect(res.json).toMatchObject({ id: read, queued: true });
    expect(sent).toEqual([{ queue: QUEUES.ingestSource, data: { newsroomId, sourceId: read } }]);
    const audit = (await call(at(`/audit?entity_id=${read}`))).json;
    expect(audit[0]).toMatchObject({ action: "fetch", person: editor });
  });
});

describe("notices since", () => {
  it("returns only those created after the time", async () => {
    await pools.system.query(
      `insert into notices (newsroom_id, kind, key, detail, created_at)
       values ($1, 'slot-missed', 'old', '{}', now() - interval '2 days'), ($1, 'slot-missed', 'new', '{}', now())`,
      [newsroomId],
    );
    signedIn = editor;
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const recent = (await call(at(`/notices?since=${since}`))).json;
    expect(recent.map((n: { key: string }) => n.key)).toEqual(["new"]);
  });
});

describe("the platform admin", () => {
  it("reads host status and the platform audit log, and hands the role over only from the desk", async () => {
    const { rows } = await pools.system.query<{ id: string }>(
      "select id from users where platform_admin",
    );
    const previous = rows[0]?.id;
    await pools.system.query("update users set platform_admin = false where platform_admin");
    await pools.system.query("update users set platform_admin = true where id = $1", [ids[chief]]);
    try {
      await pools.migrator.query("insert into deploys (tag, ok) values ('v9.9.9', true)");
      signedIn = chief;
      const host = (await call("/desk/admin/host")).json;
      expect(host.deploys[0]).toMatchObject({ tag: "v9.9.9", ok: true });
      expect(host.migration).toMatch(/^\d{14}$/);
      expect((await call("/desk/admin/audit?limit=5")).status).toBe(200);

      const { json: issued } = await call("/desk/me/tokens", { body: { name: "admin agent" } });
      signedIn = null;
      expect(
        (await call("/desk/admin/hand-over", { token: issued.token, body: { email: editor } }))
          .status,
      ).toBe(403);
      signedIn = chief;
      expect((await call("/desk/admin/hand-over", { body: { email: editor } })).json).toEqual({
        email: editor,
        platform_admin: true,
      });
      signedIn = editor;
      expect((await call("/desk/me")).json.platform_admin).toBe(true);
    } finally {
      await pools.migrator.query("delete from deploys where tag = 'v9.9.9'");
      await pools.system.query("update users set platform_admin = false where platform_admin");
      if (previous)
        await pools.system.query("update users set platform_admin = true where id = $1", [
          previous,
        ]);
    }
  });
});
