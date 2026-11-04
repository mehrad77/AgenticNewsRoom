// Starting and stopping the check of imported news at the desk on anr_test (D184).
import { randomBytes } from "node:crypto";
import { QUEUES } from "@anr/core";
import { platformKey } from "@anr/db";
import { createTestNewsroom, testPools } from "@anr/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";

const pools = testPools();
afterAll(() => pools.end());
const sent: { queue: string; data: unknown; options: unknown }[] = [];
let signedIn: string | null = null;
const app = createApp({
  pool: pools.app,
  boss: {
    send: async (queue: string, data: object, options: unknown) => (
      sent.push({ queue, data, options }), "job"
    ),
  } as never,
  platform: platformKey(randomBytes(32).toString("base64")),
  verify: async () => signedIn,
  site: { rootDomain: "example.test" },
});
const call = async (path: string, body?: unknown): Promise<Response> =>
  app.request(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

let newsroomId = "";
let base = "";
const chief = `chief-${randomBytes(4).toString("hex")}@example.test`;
const editor = `editor-${randomBytes(4).toString("hex")}@example.test`;

beforeAll(async () => {
  newsroomId = await createTestNewsroom(pools.system, "recheck");
  const { rows } = await pools.system.query<{ slug: string }>(
    "select slug from newsrooms where id = $1",
    [newsroomId],
  );
  base = `/desk/newsrooms/${rows[0]?.slug}/recheck`;
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
});

describe("the recheck at the desk", () => {
  it("is started and stopped by the Editor-in-Chief only", async () => {
    signedIn = editor;
    expect((await call(`${base}/start`, {})).status).toBe(403);
    expect(((await (await call(base)).json()) as { run: unknown }).run).toBeNull();

    signedIn = chief;
    const started = await call(`${base}/start`, {});
    expect(started.status).toBe(200);
    const run = (await started.json()) as { id: string; started_by: string; finished_at: null };
    expect(run).toMatchObject({ started_by: chief, finished_at: null });
    expect(sent).toEqual([
      {
        queue: QUEUES.recheck,
        data: { newsroomId, recheckRunId: run.id },
        options: expect.objectContaining({ singletonKey: newsroomId }),
      },
    ]);
    // One open run per newsroom.
    expect((await call(`${base}/start`, {})).status).toBe(409);

    const stopping = (await (await call(`${base}/stop`, {})).json()) as Record<string, unknown>;
    expect(stopping).toMatchObject({ id: run.id, stop_requested: true, finished_at: null });
  });

  it("ends a run the worker stopped working, so it can be started again", async () => {
    signedIn = chief;
    await pools.system.query(
      "update recheck_runs set heartbeat_at = now() - interval '3 hours' where newsroom_id = $1",
      [newsroomId],
    );
    const again = await call(`${base}/start`, {});
    expect(again.status).toBe(200);
    const { rows } = await pools.system.query<{ outcome: string | null }>(
      "select outcome from recheck_runs where newsroom_id = $1 order by started_at",
      [newsroomId],
    );
    expect(rows.map((r) => r.outcome)).toEqual(["failed", null]);

    await pools.system.query(
      "update recheck_runs set finished_at = now(), outcome = 'done' where newsroom_id = $1 and finished_at is null",
      [newsroomId],
    );
    expect((await call(`${base}/stop`, {})).status).toBe(409);
    const page = (await (await call(base)).json()) as { run: { outcome: string } };
    expect(page.run.outcome).toBe("done");
  });
});
