// Ops controls as workers obey them (D144), on anr_test. The pause of every newsroom is only ever
// set inside a rolled-back transaction: other test files publish in parallel on this database.
import { PUBLISHING_PAUSED_KEY } from "@anr/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withNewsroom } from "./index.ts";
import { drainControl, isPaused } from "./ops.ts";
import { createTestNewsroom, testPools } from "./testing.ts";

const pools = testPools();
let a = "";
let b = "";
let user = "";
beforeAll(async () => {
  a = await createTestNewsroom(pools.system, "ops-a");
  b = await createTestNewsroom(pools.system, "ops-b");
  const { rows } = await pools.system.query<{ id: string }>(
    "insert into users (email) values ($1) returning id",
    [`ops-${crypto.randomUUID()}@example.invalid`],
  );
  user = rows[0]?.id ?? "";
});
afterAll(async () => {
  await pools.migrator.query("delete from queue_drains where queue = 'channel-stats'");
  await pools.end();
});

describe("isPaused", () => {
  it("sees its own newsroom's pause, never another's", async () => {
    await withNewsroom(pools.app, a, (c) =>
      c.query("insert into publishing_pauses (newsroom_id, paused_by) values ($1, $2)", [a, user]),
    );
    expect(await withNewsroom(pools.app, a, isPaused)).toBe(true);
    expect(await withNewsroom(pools.app, b, isPaused)).toBe(false);
    await withNewsroom(pools.app, a, (c) => c.query("delete from publishing_pauses"));
    expect(await withNewsroom(pools.app, a, isPaused)).toBe(false);
  });

  it("sees the pause of every newsroom", async () => {
    const client = await pools.app.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('anr.newsroom_id', $1, true)", [b]);
      await client.query(
        `insert into platform_settings (key, value) values ($1, 'true')
         on conflict (key) do update set value = excluded.value`,
        [PUBLISHING_PAUSED_KEY],
      );
      expect(await isPaused(client)).toBe(true);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("drainControl", () => {
  const fakeBoss = () => {
    const calls: string[] = [];
    return {
      calls,
      boss: {
        work: async (queue: string) => {
          calls.push(`work ${queue}`);
          return queue;
        },
        offWork: async (queue: string) => {
          calls.push(`off ${queue}`);
        },
      },
    };
  };

  it("never works a drained queue, stops when drained and starts again when lifted", async () => {
    await pools.app.query(
      "insert into queue_drains (queue, drained_by) values ('channel-stats', $1)",
      [user],
    );
    const f = fakeBoss();
    const drains = drainControl(pools.app, f.boss as never, () => {});
    for (const queue of ["channel-stats", "channel-check"])
      await drains.boss.work(queue, async () => {});
    await drains.sync();
    // A drained queue takes no new job: no worker fetches from it.
    expect(drains.working()).toEqual(["channel-check"]);
    await pools.app.query("delete from queue_drains where queue = 'channel-stats'");
    await drains.sync();
    expect(drains.working().sort()).toEqual(["channel-check", "channel-stats"]);
    await pools.app.query(
      "insert into queue_drains (queue, drained_by) values ('channel-stats', $1)",
      [user],
    );
    await drains.sync();
    expect(f.calls).toEqual(["work channel-check", "work channel-stats", "off channel-stats"]);
    drains.stop();
  });

  it("refuses a drain on a queue outside the allowed list", async () => {
    for (const queue of [
      "publish-correction",
      "assign",
      "redraft",
      "pick-deadline",
      "publish-sweep",
    ])
      await expect(
        pools.app.query("insert into queue_drains (queue, drained_by) values ($1, $2)", [
          queue,
          user,
        ]),
      ).rejects.toThrow(/queue_drains_queue_check/);
  });
});
