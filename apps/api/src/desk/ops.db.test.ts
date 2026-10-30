// The platform admin's Ops controls (D144) on anr_test. The pause of every newsroom is set only
// inside a rolled-back transaction, since other test files publish on this database meanwhile.
import { randomBytes } from "node:crypto";
import { PUBLISHING_PAUSED_KEY, QUEUES } from "@anr/core";
import { createBoss, platformKey, withNewsroom } from "@anr/db";
import { createTestNewsroom, testDatabaseUrl, testPools } from "@anr/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { cancelJob, pause, requestBackupCheck, resume, retryJob, setDrain } from "./ops.ts";

const pools = testPools();
const boss = createBoss(testDatabaseUrl(process.env.DATABASE_URL ?? ""), "ops-test", {
  supervise: false,
  schedule: false,
});
let actor = { kind: "person" as const, userId: "" };
let newsroomId = "";
let slug = "";

beforeAll(async () => {
  await boss.start();
  newsroomId = await createTestNewsroom(pools.system, "ops");
  slug = (
    await pools.system.query<{ slug: string }>("select slug from newsrooms where id = $1", [
      newsroomId,
    ])
  ).rows[0]?.slug as string;
  const { rows } = await pools.system.query<{ id: string }>(
    "insert into users (email) values ($1) returning id",
    [`ops-admin-${randomBytes(4).toString("hex")}@example.invalid`],
  );
  actor = { kind: "person", userId: rows[0]?.id ?? "" };
});
afterAll(async () => {
  await pools.migrator.query("delete from queue_drains where queue = 'ingest-media'");
  await boss.stop({ graceful: false });
  await pools.end();
});

const audits = async (action: string, key: string) =>
  (
    await pools.system.query<{ before: unknown; after: unknown }>(
      "select before, after from platform_audit_log where actor_user_id = $1 and action = $2 and key = $3",
      [actor.userId, action, key],
    )
  ).rows;

describe("pausing and resuming a newsroom", () => {
  it("pauses it, audited once, and on resume holds only what is now past its grace", async () => {
    await pause(pools.app, actor, slug);
    await pause(pools.app, actor, slug);
    expect(
      (
        await pools.system.query("select from publishing_pauses where newsroom_id = $1", [
          newsroomId,
        ])
      ).rowCount,
    ).toBe(1);
    expect(await audits("pause", slug)).toEqual([{ before: false, after: true }]);

    const series = (
      await pools.system.query<{ id: string }>(
        `insert into series (newsroom_id, slug, format_id, languages, config)
         select $1, 'daily', f.id, '{en}', '{}' from formats f where f.slug = 'newsletter-issue'
         returning id`,
        [newsroomId],
      )
    ).rows[0]?.id;
    const scheduled = async (slot: string) => {
      const assignment = (
        await pools.system.query<{ id: string }>(
          "insert into assignments (newsroom_id, series_id, slot) values ($1, $2, $3) returning id",
          [newsroomId, series, slot],
        )
      ).rows[0]?.id;
      return (
        await pools.system.query<{ id: string }>(
          `insert into publications (newsroom_id, series_id, assignment_id, slot, language, status)
           values ($1, $2, $3, $4, 'en', 'scheduled') returning id`,
          [newsroomId, series, assignment, slot],
        )
      ).rows[0]?.id;
    };
    // Resumed at 21:00: the 20:00 newsletter is past its 30 minutes, the 20:40 one is not.
    const late = await scheduled("2032-01-05T20:00:00Z");
    const onTime = await scheduled("2032-01-05T20:40:00Z");
    const { held } = await resume(pools.app, actor, slug, new Date("2032-01-05T21:00:00Z"));
    expect(held).toEqual([late]);
    const status = async (id?: string) =>
      (await pools.system.query("select status from publications where id = $1", [id])).rows[0]
        ?.status;
    expect(await status(late)).toBe("with-editor");
    expect(await status(onTime)).toBe("scheduled");
    expect(await audits("resume", slug)).toEqual([{ before: true, after: false }]);
    const notice = await withNewsroom(pools.app, newsroomId, (c) =>
      c.query("select key from notices where kind = 'slot-missed'"),
    );
    expect(notice.rows).toEqual([{ key: late }]);
  });

  it("pauses every newsroom, audited", async () => {
    const client = await pools.app.connect();
    // The test's own transaction, rolled back: pause() opens and commits none of its own here.
    const inside = {
      query: (text: string, params?: unknown[]) =>
        /^(begin|commit|rollback)$/.test(text)
          ? Promise.resolve({ rows: [] })
          : client.query(text, params),
      release: () => {},
    };
    try {
      await client.query("begin");
      await pause({ connect: async () => inside, query: inside.query } as never, actor);
      const { rows } = await client.query<{ value: unknown }>(
        "select value from platform_settings where key = $1",
        [PUBLISHING_PAUSED_KEY],
      );
      expect(rows[0]?.value).toBe(true);
      const audit = await client.query(
        "select after from platform_audit_log where actor_user_id = $1 and action = 'pause' and key = $2",
        [actor.userId, PUBLISHING_PAUSED_KEY],
      );
      expect(audit.rows).toEqual([{ after: true }]);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("cancel and drain (D144)", () => {
  it.each([
    QUEUES.publishCorrection,
    QUEUES.assign,
    QUEUES.redraft,
    QUEUES.pickDeadline,
    QUEUES.challengeDeadline,
    QUEUES.publishSweep,
  ])("are refused for %s", async (queue) => {
    const id = "00000000-0000-0000-0000-000000000000";
    await expect(cancelJob(pools.app, boss, actor, queue, id)).rejects.toMatchObject({
      status: 403,
    });
    await expect(setDrain(pools.app, actor, queue, true)).rejects.toMatchObject({ status: 403 });
  });

  it("cancels a job that has not started, never a running one, and audits it", async () => {
    const waiting =
      (await boss.send(QUEUES.ingestMedia, { newsroomId, url: "https://x.test/a" })) ?? "";
    await cancelJob(pools.app, boss, actor, QUEUES.ingestMedia, waiting);
    const state = async (id: string) =>
      (await pools.system.query("select state::text from pgboss.job where id = $1", [id])).rows[0]
        ?.state;
    expect(await state(waiting)).toBe("cancelled");
    expect(await audits("cancel", `${QUEUES.ingestMedia}/${waiting}`)).toHaveLength(1);
    // The member's image is not dropped in silence (D119): the same notice as a failed fetch.
    const notice = await withNewsroom(pools.app, newsroomId, (c) =>
      c.query(
        "select detail->>'outcome' as outcome from notices where kind = 'media-failed' and key = $1",
        ["https://x.test/a"],
      ),
    );
    expect(notice.rows).toEqual([{ outcome: "cancelled" }]);

    const running =
      (await boss.send(QUEUES.ingestMedia, { newsroomId, url: "https://x.test/b" })) ?? "";
    await pools.system.query(
      "update pgboss.job set state = 'active', started_on = now() where id = $1",
      [running],
    );
    await expect(
      cancelJob(pools.app, boss, actor, QUEUES.ingestMedia, running),
    ).rejects.toMatchObject({ status: 409 });
    await pools.system.query(
      "update pgboss.job set state = 'failed', completed_on = now() where id = $1",
      [running],
    );
    // A failed job is retried, also audited.
    await retryJob(pools.app, boss, actor, QUEUES.ingestMedia, running);
    expect(await state(running)).toBe("retry");
    expect(await audits("retry", `${QUEUES.ingestMedia}/${running}`)).toHaveLength(1);
    await boss.cancel(QUEUES.ingestMedia, running);
  });

  it("closes the agent run of a cancelled agent-run job, so a later redraft can start", async () => {
    const run = (
      await pools.system.query<{ id: string }>(
        `insert into agent_runs (newsroom_id, role, provider, model, prompt_version, input_hash)
         values ($1, 'desk', 'p', 'm', 'v', '\\x00') returning id`,
        [newsroomId],
      )
    ).rows[0]?.id;
    const job = (await boss.send(QUEUES.agentRun, { newsroomId, agentRunId: run })) ?? "";
    await cancelJob(pools.app, boss, actor, QUEUES.agentRun, job);
    const { rows } = await pools.system.query(
      "select outcome, finished_at is not null as finished from agent_runs where id = $1",
      [run],
    );
    expect(rows).toEqual([{ outcome: "error", finished: true }]);
  });

  it("drains an allowed queue and lifts it, audited each way", async () => {
    await setDrain(pools.app, actor, QUEUES.ingestMedia, true);
    expect(
      (await pools.system.query("select from queue_drains where queue = 'ingest-media'")).rowCount,
    ).toBe(1);
    await setDrain(pools.app, actor, QUEUES.ingestMedia, false);
    expect(
      (await pools.system.query("select from queue_drains where queue = 'ingest-media'")).rowCount,
    ).toBe(0);
    expect(await audits("drain", QUEUES.ingestMedia)).toHaveLength(1);
    expect(await audits("undrain", QUEUES.ingestMedia)).toHaveLength(1);
  });

  it("asks the host for a backup check, audited", async () => {
    const { id } = await requestBackupCheck(pools.app, actor);
    const { rows } = await pools.system.query(
      "select kind, picked_at from ops_requests where id = $1",
      [id],
    );
    expect(rows).toEqual([{ kind: "backup-check", picked_at: null }]);
    expect(await audits("request", id)).toHaveLength(1);
  });
});

describe("the Ops routes", () => {
  it("refuse a signed-in person who is not the platform admin", async () => {
    const email = `editor-${randomBytes(4).toString("hex")}@example.invalid`;
    await pools.system.query("insert into users (email) values ($1)", [email]);
    const app = createApp({
      pool: pools.app,
      boss: boss as never,
      platform: platformKey(randomBytes(32).toString("base64")),
      verify: async () => email,
      site: { rootDomain: "example.test" },
    });
    for (const [method, path] of [
      ["GET", "/desk/admin/ops"],
      ["POST", "/desk/admin/ops/pause"],
      ["POST", "/desk/admin/ops/drain"],
    ] as const) {
      const res = await app.request(path, {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "POST" && { body: "{}" }),
      });
      expect(res.status).toBe(403);
    }
  });
});
