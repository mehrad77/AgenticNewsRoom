// TTS engines at the desk on anr_test (D113): the platform admin enables engines; a newsroom's
// Editor-in-Chief picks one per language from those; everyone else only reads.
import { randomBytes } from "node:crypto";
import { platformKey } from "@anr/db";
import { createTestNewsroom, testPools } from "@anr/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { TtsCatalog } from "./tts.ts";

const pools = testPools();
// platform_settings is shared by everything on anr_test: this file puts it back as it found it.
let saved: unknown;
let savedAdmin: string | undefined;
afterAll(async () => {
  // An upsert: no role may delete a platform setting. JSON null reads as "nothing chosen".
  await pools.system.query(
    `insert into platform_settings (key, value) values ('tts.engines', $1)
     on conflict (key) do update set value = excluded.value`,
    [JSON.stringify(saved ?? null)],
  );
  await pools.system.query("update users set platform_admin = false where platform_admin");
  if (savedAdmin)
    await pools.system.query("update users set platform_admin = true where id = $1", [savedAdmin]);
  await pools.end();
});
const tts: TtsCatalog = {
  default: "gemini",
  engines: [
    { id: "gemini", model: "gemini-tts", languages: ["fa", "en", "tr"], local: false },
    { id: "xtts", model: "xtts-v2", languages: ["en", "tr"], local: true },
    { id: "dia", model: "dia-1.6b", languages: ["en"], local: true },
  ],
};
let signedIn: string | null = null;
const app = createApp({
  pool: pools.app,
  boss: { send: async () => "job" } as never,
  platform: platformKey(randomBytes(32).toString("base64")),
  verify: async () => signedIn,
  site: { rootDomain: "example.test" },
  tts,
});

const tag = randomBytes(4).toString("hex");
const admin = `admin-${tag}@example.test`;
const chief = `chief-${tag}@example.test`;
const editor = `editor-${tag}@example.test`;
let newsroomId = "";
let slug = "";

beforeAll(async () => {
  saved = (
    await pools.system.query<{ value: unknown }>(
      "select value from platform_settings where key = 'tts.engines'",
    )
  ).rows[0]?.value;
  savedAdmin = (
    await pools.system.query<{ id: string }>("select id from users where platform_admin")
  ).rows[0]?.id;
  newsroomId = await createTestNewsroom(pools.system, "tts");
  slug = (
    await pools.system.query<{ slug: string }>(
      "update newsrooms set languages = '{fa,en}' where id = $1 returning slug",
      [newsroomId],
    )
  ).rows[0]?.slug as string;
  const user = async (email: string) =>
    (
      await pools.system.query<{ id: string }>(
        "insert into users (email) values ($1) returning id",
        [email],
      )
    ).rows[0]?.id as string;
  // The one platform admin of the test database is this file's.
  await pools.system.query("update users set platform_admin = false where platform_admin");
  await pools.system.query("update users set platform_admin = true where id = $1", [
    await user(admin),
  ]);
  for (const [email, role] of [
    [chief, "editor-in-chief"],
    [editor, "editor"],
  ] as const) {
    await pools.system.query(
      "insert into memberships (newsroom_id, user_id, role) values ($1, $2, $3)",
      [newsroomId, await user(email), role],
    );
  }
});

const call = async (path: string, body?: unknown): Promise<Response> =>
  app.request(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const isAdmin = async () =>
  ((await (await call("/desk/me")).json()) as { platform_admin: boolean }).platform_admin;

describe("TTS engines (D113)", () => {
  it("allows exactly one platform admin", async () => {
    await expect(
      pools.system.query("update users set platform_admin = true where lower(email) = lower($1)", [
        chief,
      ]),
    ).rejects.toThrow(/users_one_platform_admin/);
  });

  it("lets only the platform admin enable engines, audited", async () => {
    signedIn = chief;
    expect(await isAdmin()).toBe(false);
    expect((await call("/desk/admin/tts")).status).toBe(403);
    expect((await call("/desk/admin/tts", { engines: ["xtts"] })).status).toBe(403);

    signedIn = admin;
    expect(await isAdmin()).toBe(true);
    expect((await call("/desk/admin/tts", { engines: ["nope"] })).status).toBe(400);
    expect((await call("/desk/admin/tts", { engines: ["gemini", "xtts"] })).status).toBe(200);
    const listed = (await call("/desk/admin/tts").then((r) => r.json())) as {
      engines: { id: string; enabled: boolean }[];
    };
    expect(listed.engines.map((e) => [e.id, e.enabled])).toEqual([
      ["gemini", true],
      ["xtts", true],
      ["dia", false],
    ]);
    const { rows } = await pools.system.query<{ after: string[] }>(
      "select after from platform_audit_log where key = 'tts.engines' order by at desc limit 1",
    );
    expect(rows[0]?.after).toEqual(["gemini", "xtts"]);
  });

  it("lets the Editor-in-Chief choose an enabled engine that speaks the language", async () => {
    signedIn = editor;
    expect(
      (await call(`/desk/newsrooms/${slug}/tts`, { language: "en", engine: "xtts" })).status,
    ).toBe(403);

    signedIn = chief;
    const reasons = async () =>
      (
        (await call(`/desk/newsrooms/${slug}/tts`).then((r) => r.json())) as {
          languages: {
            language: string;
            effective: string | null;
            source: string | null;
            options: string[];
          }[];
        }
      ).languages;
    // Nothing chosen: the default speaks both languages.
    expect((await reasons()).map((l) => [l.language, l.effective, l.source, l.options])).toEqual([
      ["fa", "gemini", "default", ["gemini"]],
      ["en", "gemini", "default", ["gemini", "xtts"]],
    ]);
    expect(
      (await call(`/desk/newsrooms/${slug}/tts`, { language: "fa", engine: "xtts" })).status,
    ).toBe(400);
    expect(
      (await call(`/desk/newsrooms/${slug}/tts`, { language: "en", engine: "dia" })).status,
    ).toBe(400);
    expect(
      (await call(`/desk/newsrooms/${slug}/tts`, { language: "en", engine: "xtts" })).status,
    ).toBe(200);
    expect((await reasons())[1]).toMatchObject({
      language: "en",
      effective: "xtts",
      source: "newsroom",
    });

    // The admin turns xtts off: English falls back to the default, the choice stays.
    signedIn = admin;
    await call("/desk/admin/tts", { engines: ["gemini"] });
    signedIn = chief;
    expect((await reasons())[1]).toMatchObject({ effective: "gemini", source: "default" });

    expect(
      (await call(`/desk/newsrooms/${slug}/tts`, { language: "en", engine: null })).status,
    ).toBe(200);
    const { rows } = await pools.system.query<{ action: string }>(
      "select action from audit_log where newsroom_id = $1 and entity = 'newsroom_tts' order by at",
      [newsroomId],
    );
    expect(rows.map((r) => r.action)).toEqual(["choose", "clear"]);
  });
});
