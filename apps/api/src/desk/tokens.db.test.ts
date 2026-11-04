// Personal tokens on anr_test (D189, D191): a token acts as its person, never mints another, and
// every act through it is audited with the token.
import { randomBytes } from "node:crypto";
import { platformKey } from "@anr/db";
import { createTestNewsroom, testPools } from "@anr/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";

const pools = testPools();
afterAll(() => pools.end());
let signedIn: string | null = null;
const app = createApp({
  pool: pools.app,
  boss: { send: async () => "job" } as never,
  platform: platformKey(randomBytes(32).toString("base64")),
  verify: async () => signedIn,
  site: { rootDomain: "example.test" },
});
const call = async (
  path: string,
  init: { body?: unknown; token?: string } = {},
): Promise<{ status: number; json: Record<string, unknown> }> => {
  const res = await app.request(path, {
    method: init.body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

let newsroomId = "";
let slug = "";
const chief = `chief-${randomBytes(4).toString("hex")}@example.test`;
let chiefId = "";

beforeAll(async () => {
  newsroomId = await createTestNewsroom(pools.system, "tokens");
  const { rows } = await pools.system.query<{ slug: string }>(
    "select slug from newsrooms where id = $1",
    [newsroomId],
  );
  slug = rows[0]?.slug ?? "";
  const { rows: users } = await pools.system.query<{ id: string }>(
    "insert into users (email) values ($1) returning id",
    [chief],
  );
  chiefId = users[0]?.id ?? "";
  await pools.system.query(
    "insert into memberships (newsroom_id, user_id, role) values ($1, $2, 'editor-in-chief')",
    [newsroomId, chiefId],
  );
});

/** Runs `fn` with the chief as the platform's one admin, then puts the previous admin back. */
const asAdmin = async (fn: () => Promise<void>) => {
  const { rows } = await pools.system.query<{ id: string }>(
    "select id from users where platform_admin",
  );
  await pools.system.query("update users set platform_admin = false where platform_admin");
  await pools.system.query("update users set platform_admin = true where id = $1", [chiefId]);
  try {
    await fn();
  } finally {
    await pools.system.query("update users set platform_admin = false where platform_admin");
    if (rows[0])
      await pools.system.query("update users set platform_admin = true where id = $1", [
        rows[0].id,
      ]);
  }
};

describe("a personal token", () => {
  it("is issued once in a desk session and acts as its person", async () => {
    signedIn = chief;
    const issued = await call("/desk/me/tokens", { body: { name: "Claude Code", days: 7 } });
    expect(issued.status).toBe(201);
    const token = issued.json.token as string;
    expect(token).toMatch(/^anr_[A-Za-z0-9_-]{43}$/);

    // The list never shows the token again.
    const listed = await call("/desk/me/tokens");
    expect(JSON.stringify(listed.json)).not.toContain(token);

    signedIn = null;
    const me = await call("/desk/me", { token });
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ email: chief, via_token: issued.json.id });
    expect(me.json.memberships).toEqual([expect.objectContaining({ newsroom: slug })]);
    const { rows } = await pools.system.query<{ last_used_at: Date | null }>(
      "select last_used_at from personal_tokens where id = $1",
      [issued.json.id],
    );
    expect(rows[0]?.last_used_at).not.toBeNull();
  });

  it("cannot issue, list or revoke tokens, nor manage anyone's", async () => {
    signedIn = chief;
    const { json } = await call("/desk/me/tokens", { body: { name: "agent" } });
    const token = json.token as string;
    signedIn = null;
    expect((await call("/desk/me/tokens", { token })).status).toBe(403);
    expect((await call("/desk/me/tokens", { token, body: { name: "another" } })).status).toBe(403);
    expect((await call(`/desk/me/tokens/${json.id}/revoke`, { token, body: {} })).status).toBe(403);
    await asAdmin(async () => {
      expect((await call("/desk/admin/tokens", { token })).status).toBe(403);
      // The admin's other routes are open to the token, as to the person.
      expect((await call("/desk/admin/tts", { token })).status).toBe(200);
    });
  });

  it("stops working once revoked or expired, and a made-up one never works", async () => {
    signedIn = chief;
    const { json } = await call("/desk/me/tokens", { body: { name: "short-lived" } });
    const token = json.token as string;
    expect(
      (await call(`/desk/me/tokens/${json.id}/revoke`, { body: {} })).json.revoked_at,
    ).not.toBeNull();
    signedIn = null;
    expect((await call("/desk/me", { token })).status).toBe(401);

    signedIn = chief;
    const other = await call("/desk/me/tokens", { body: { name: "expiring" } });
    await pools.system.query(
      "update personal_tokens set created_at = now() - interval '2 days', expires_at = now() - interval '1 second' where id = $1",
      [other.json.id],
    );
    signedIn = null;
    expect((await call("/desk/me", { token: other.json.token as string })).status).toBe(401);
    expect((await call("/desk/me", { token: `anr_${"A".repeat(43)}` })).status).toBe(401);
    expect((await call("/desk/me", { token: "not-a-token" })).status).toBe(401);
  });

  it("is recorded on what its person does through it", async () => {
    signedIn = chief;
    const { json } = await call("/desk/me/tokens", { body: { name: "recheck agent" } });
    signedIn = null;
    const started = await call(`/desk/newsrooms/${slug}/recheck/start`, {
      token: json.token as string,
      body: {},
    });
    expect(started.status).toBe(200);
    expect(started.json.started_by).toBe(chief);
    await pools.system.query(
      "update recheck_runs set finished_at = now(), outcome = 'stopped' where newsroom_id = $1 and finished_at is null",
      [newsroomId],
    );

    // An audited act: the person is the actor, and the token is named.
    await asAdmin(async () => {
      const token = json.token as string;
      expect(
        (await call("/desk/admin/ops/pause", { token, body: { newsroom: slug } })).status,
      ).toBe(200);
      expect(
        (await call("/desk/admin/ops/resume", { token, body: { newsroom: slug } })).status,
      ).toBe(200);
    });
    const { rows } = await pools.system.query<{ actor_user_id: string; via_token_id: string }>(
      "select actor_user_id, via_token_id from platform_audit_log where key = $1 and action in ('pause', 'resume')",
      [slug],
    );
    expect(rows).toEqual([
      { actor_user_id: chiefId, via_token_id: json.id },
      { actor_user_id: chiefId, via_token_id: json.id },
    ]);
  });
});
