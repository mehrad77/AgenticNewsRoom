// Role chains and the local model server at the desk, on anr_test: only the platform admin may see
// or change them, every change is audited, and LM Studio is a fake fetch.
import { randomBytes } from "node:crypto";
import { MODEL_ROLES_KEY } from "@anr/core";
import { platformKey } from "@anr/db";
import { testPools } from "@anr/db/testing";
import type { ModelsConfig } from "@anr/models";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { holdPlatformAdmin } from "../../test/platform-admin.ts";
import { createApp } from "../app.ts";
import type { ModelsSetup } from "./models.ts";

const pools = testPools();
const price = { in: 1, out: 2 };
const config: ModelsConfig = {
  providers: {
    cloud: { kind: "google", key_env: "CLOUD_KEY" },
    lmstudio: { kind: "openai", base_url: "http://host.docker.internal:1234/v1" },
  },
  models: {
    big: { provider: "cloud", model: "big-1", family: "big", tools: true, price },
    small: { provider: "cloud", model: "small-1", family: "small", tools: true, price },
    oss: { provider: "lmstudio", model: "openai/gpt-oss-20b", family: "oss", tools: true, price },
    voice: { provider: "cloud", model: "voice-1", family: "voice", tools: false, price },
  },
  roles: {
    planner: ["oss", "big"],
    desk: { default: ["oss", "big"], by_format: { "newsletter-issue": ["oss", "small"] } },
    renderer: ["oss", "small"],
    "fact-checker": ["small", "oss", "big"],
    "item-matcher": ["small"],
    summariser: ["small"],
  },
  tts: "voice",
};
const models: ModelsSetup = { config, formats: ["newsletter-issue", "classic-article"] };

// The fake LM Studio: what it lists, what it was sent, and whether it is running.
let running = true;
const sent: { url: string; body: unknown }[] = [];
const listed = {
  models: [
    {
      type: "llm",
      key: "openai/gpt-oss-20b",
      display_name: "GPT-OSS 20B",
      size_bytes: 12_000_000_000,
      params_string: "20B",
      max_context_length: 131_072,
      loaded_instances: [{ id: "openai/gpt-oss-20b", config: { context_length: 65_536 } }],
      capabilities: { trained_for_tool_use: true },
    },
    {
      type: "llm",
      key: "google/gemma-4-12b",
      display_name: "Gemma 4 12B",
      size_bytes: 8_000_000_000,
      params_string: "12B",
      max_context_length: 32_768,
      loaded_instances: [],
      capabilities: { trained_for_tool_use: true },
    },
    { type: "embedding", key: "nomic-embed", display_name: "Nomic", loaded_instances: [] },
  ],
};
const fakeFetch = (async (url: string, init?: RequestInit) => {
  if (!running) throw new TypeError("fetch failed");
  if (init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    sent.push({ url, body });
    return Response.json(
      url.endsWith("/load") ? { type: "llm", instance_id: body.model, status: "loaded" } : {},
    );
  }
  return Response.json(listed);
}) as unknown as typeof fetch;

let signedIn: string | null = null;
const app = createApp({
  pool: pools.app,
  boss: { send: async () => "job" } as never,
  platform: platformKey(randomBytes(32).toString("base64")),
  verify: async () => signedIn,
  site: { rootDomain: "example.test" },
  models,
  fetch: fakeFetch,
});

const tag = randomBytes(4).toString("hex");
const admin = `models-admin-${tag}@example.test`;
const someone = `models-someone-${tag}@example.test`;
let adminId = "";
let saved: unknown;
let savedAdmin: string | undefined;
let releaseAdmin = async () => {};

beforeAll(async () => {
  releaseAdmin = await holdPlatformAdmin(pools.system);
  const setting = async () =>
    (
      await pools.system.query<{ value: unknown }>(
        "select value from platform_settings where key = $1",
        [MODEL_ROLES_KEY],
      )
    ).rows;
  saved = (await setting())[0]?.value ?? null;
  savedAdmin = (
    await pools.system.query<{ id: string }>("select id from users where platform_admin")
  ).rows[0]?.id;
  const user = async (email: string) =>
    (
      await pools.system.query<{ id: string }>(
        "insert into users (email) values ($1) returning id",
        [email],
      )
    ).rows[0]?.id as string;
  adminId = await user(admin);
  await user(someone);
  await pools.system.query("update users set platform_admin = false where platform_admin");
  await pools.system.query("update users set platform_admin = true where id = $1", [adminId]);
}, 60_000);

afterAll(async () => {
  // An upsert: no role may delete a platform setting; JSON null reads as the models file's.
  await pools.system.query(
    `insert into platform_settings (key, value) values ($1, $2)
     on conflict (key) do update set value = excluded.value`,
    [MODEL_ROLES_KEY, JSON.stringify(saved)],
  );
  await pools.system.query("update users set platform_admin = false where platform_admin");
  if (savedAdmin)
    await pools.system.query("update users set platform_admin = true where id = $1", [savedAdmin]);
  await releaseAdmin();
  await pools.end();
});

const call = (path: string, method = "GET", body?: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async <T = Record<string, unknown>>(res: Response | Promise<Response>) =>
  (await (await res).json()) as T;
const audits = async (entity: string) =>
  (
    await pools.system.query<{ action: string; key: string; before: unknown; after: unknown }>(
      `select action, key, before, after from platform_audit_log
       where actor_user_id = $1 and entity = $2 order by at`,
      [adminId, entity],
    )
  ).rows;
const chains = (change: (r: ModelsConfig["roles"]) => void) => {
  const r = structuredClone(config.roles);
  change(r);
  return r;
};

describe("role chains at the desk", () => {
  it("are the platform admin's alone", async () => {
    signedIn = someone;
    const tries: [string, string, unknown?][] = [
      ["/desk/admin/models", "GET"],
      ["/desk/admin/models/roles", "PUT", config.roles],
      ["/desk/admin/models/roles", "DELETE"],
      ["/desk/admin/models/local", "GET"],
      ["/desk/admin/models/local/load", "POST", { model: "google/gemma-4-12b" }],
      ["/desk/admin/models/local/unload", "POST", { instance_id: "openai/gpt-oss-20b" }],
    ];
    for (const [path, method, body] of tries) {
      expect((await call(path, method, body)).status, `${method} ${path}`).toBe(403);
    }
    expect(sent).toEqual([]);
  });

  it("show the catalog, and the models file's chains before any change", async () => {
    signedIn = admin;
    await call("/desk/admin/models/roles", "DELETE");
    const got = await json(call("/desk/admin/models"));
    expect(got.source).toBe("file");
    expect(got.roles).toEqual(config.roles);
    expect(got.file_roles).toEqual(config.roles);
    expect(got.problems).toEqual([]);
    expect(got.formats).toEqual(models.formats);
    expect(got.catalog).toContainEqual({
      id: "oss",
      provider: "lmstudio",
      provider_kind: "openai",
      model: "openai/gpt-oss-20b",
      family: "oss",
      tools: true,
      price,
      local: true,
    });
    expect(got.catalog).toContainEqual(expect.objectContaining({ id: "big", local: false }));
  });

  it("refuse chains that fail the models file's rules, listing every problem", async () => {
    signedIn = admin;
    const before = (await audits("platform_settings")).length;
    const bad = chains((r) => {
      r.planner = ["voice", "gone"];
      r["fact-checker"] = ["oss"];
    });
    const res = await call("/desk/admin/models/roles", "PUT", bad);
    expect(res.status).toBe(400);
    const body = await json<{ error: string; problems: string[] }>(res);
    expect(body.problems).toEqual([
      "planner: voice has no tool calling",
      "planner: unknown model gone",
      "fact-checker needs models from at least two families",
    ]);
    expect(body.error).toContain("fact-checker needs models from at least two families");
    // Not chains at all.
    const shape = await call("/desk/admin/models/roles", "PUT", { planner: [] });
    expect(shape.status).toBe(400);
    expect((await json<{ problems: string[] }>(shape)).problems.length).toBeGreaterThan(0);
    expect((await audits("platform_settings")).length).toBe(before);
    expect((await json(call("/desk/admin/models"))).source).toBe("file");
  });

  it("save valid chains, audited with before and after, and reset to the file's", async () => {
    signedIn = admin;
    const next = chains((r) => {
      r.planner = ["big", "oss"];
      r.desk.by_format = {};
    });
    const saved = await json(call("/desk/admin/models/roles", "PUT", next));
    expect(saved.source).toBe("desk");
    expect(saved.roles).toEqual(next);
    expect(saved.file_roles).toEqual(config.roles);
    expect((await json(call("/desk/admin/models"))).roles).toEqual(next);

    const reset = await json(call("/desk/admin/models/roles", "DELETE"));
    expect(reset.source).toBe("file");
    expect(reset.roles).toEqual(config.roles);
    const { rows } = await pools.system.query<{ value: unknown }>(
      "select value from platform_settings where key = $1",
      [MODEL_ROLES_KEY],
    );
    expect(rows[0]?.value).toBeNull();

    const log = (await audits("platform_settings")).slice(-2);
    expect(log).toEqual([
      { action: "set", key: MODEL_ROLES_KEY, before: null, after: next },
      { action: "reset", key: MODEL_ROLES_KEY, before: next, after: null },
    ]);
  });

  it("show stored chains a deploy made invalid as set aside, with why", async () => {
    signedIn = admin;
    const stale = chains((r) => {
      r.summariser = ["removed"];
    });
    await pools.system.query("update platform_settings set value = $2 where key = $1", [
      MODEL_ROLES_KEY,
      JSON.stringify(stale),
    ]);
    const got = await json(call("/desk/admin/models"));
    expect(got.source).toBe("file");
    expect(got.roles).toEqual(config.roles);
    expect(got.problems).toEqual(["summariser: unknown model removed"]);
  });
});

describe("the local model server", () => {
  it("lists its language models, loaded instances and the catalog ids they serve", async () => {
    signedIn = admin;
    const got = await json<{ url: string; models: Record<string, unknown>[] }>(
      call("/desk/admin/models/local"),
    );
    expect(got.url).toBe("http://host.docker.internal:1234");
    expect(got.models.map((m) => m.key)).toEqual(["openai/gpt-oss-20b", "google/gemma-4-12b"]);
    expect(got.models[0]).toEqual({
      key: "openai/gpt-oss-20b",
      display_name: "GPT-OSS 20B",
      size_bytes: 12_000_000_000,
      params: "20B",
      max_context_length: 131_072,
      tool_use: true,
      loaded: [{ id: "openai/gpt-oss-20b", context_length: 65_536 }],
      catalog_ids: ["oss"],
    });
  });

  it("says plainly when LM Studio is not running", async () => {
    signedIn = admin;
    running = false;
    try {
      for (const [path, method, body] of [
        ["/desk/admin/models/local", "GET"],
        ["/desk/admin/models/local/load", "POST", { model: "google/gemma-4-12b" }],
        ["/desk/admin/models/local/unload", "POST", { instance_id: "x" }],
      ] as const) {
        const res = await call(path, method, body);
        expect(res.status).toBe(503);
        expect((await json(res)).error).toBe(
          "LM Studio is not running at http://host.docker.internal:1234",
        );
      }
    } finally {
      running = true;
    }
  });

  it("loads a listed model with a context length in bounds, audited", async () => {
    signedIn = admin;
    sent.length = 0;
    const load = (body: unknown) => call("/desk/admin/models/local/load", "POST", body);
    expect((await load({ model: "nope/model" })).status).toBe(400);
    expect((await load({ model: "nomic-embed" })).status).toBe(400);
    expect((await load({ model: "openai/gpt-oss-20b", context_length: 2048 })).status).toBe(400);
    expect((await load({ model: "openai/gpt-oss-20b", context_length: 200_000 })).status).toBe(400);
    expect(sent).toEqual([]);

    const big = await load({ model: "openai/gpt-oss-20b" });
    expect(await json(big)).toEqual({
      model: "openai/gpt-oss-20b",
      context_length: 65_536,
      instance_id: "openai/gpt-oss-20b",
    });
    // Gemma's maximum is below the default, so it loads at its maximum.
    await load({ model: "google/gemma-4-12b" });
    await load({ model: "google/gemma-4-12b", context_length: 8192 });
    expect(sent).toEqual([
      {
        url: "http://host.docker.internal:1234/api/v1/models/load",
        body: { model: "openai/gpt-oss-20b", context_length: 65_536 },
      },
      {
        url: "http://host.docker.internal:1234/api/v1/models/load",
        body: { model: "google/gemma-4-12b", context_length: 32_768 },
      },
      {
        url: "http://host.docker.internal:1234/api/v1/models/load",
        body: { model: "google/gemma-4-12b", context_length: 8192 },
      },
    ]);
    expect((await audits("local_model")).filter((a) => a.action === "load")[0]).toEqual({
      action: "load",
      key: "openai/gpt-oss-20b",
      before: { loaded: [{ id: "openai/gpt-oss-20b", context_length: 65_536 }] },
      after: {
        model: "openai/gpt-oss-20b",
        context_length: 65_536,
        instance_id: "openai/gpt-oss-20b",
      },
    });
  });

  it("unloads a loaded instance, audited", async () => {
    signedIn = admin;
    sent.length = 0;
    const unload = (body: unknown) => call("/desk/admin/models/local/unload", "POST", body);
    expect((await unload({})).status).toBe(400);
    expect((await unload({ instance_id: "not-loaded" })).status).toBe(404);
    expect(await json(unload({ instance_id: "openai/gpt-oss-20b" }))).toEqual({ ok: true });
    expect(sent).toEqual([
      {
        url: "http://host.docker.internal:1234/api/v1/models/unload",
        body: { instance_id: "openai/gpt-oss-20b" },
      },
    ]);
    expect((await audits("local_model")).filter((a) => a.action === "unload")).toEqual([
      {
        action: "unload",
        key: "openai/gpt-oss-20b",
        before: { id: "openai/gpt-oss-20b", context_length: 65_536 },
        after: null,
      },
    ]);
  });
});
