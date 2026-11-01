// Heartbeats and outages (D128) on anr_test. Beats carry their own time here, from a base later than
// any earlier run's, so the host check (every worker silent) never sees another run's rows.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beat, health, WORKERS } from "./heartbeat.ts";
import { testPools } from "./testing.ts";

const pools = testPools();
const run = Date.now().toString(36);
const base = Date.UTC(2200, 0, 1) + Date.now();
const at = (minutes: number) => new Date(base + minutes * 60_000);
const name = (w: string) => `hb-${run}-${w}`;

const cleanup = async () => {
  await pools.migrator.query(
    "delete from heartbeats where worker like 'hb-%' or worker = any($1)",
    [WORKERS],
  );
  await pools.migrator.query("delete from outages where started_at >= $1 or worker like 'hb-%'", [
    new Date(Date.UTC(2200, 0, 1)),
  ]);
};
beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await pools.end();
});

const outages = async (from: Date) => {
  const { rows } = await pools.app.query<{
    kind: string;
    worker: string | null;
    started_at: Date;
    ended_at: Date;
  }>(
    "select kind, worker, started_at, ended_at from outages where started_at >= $1 order by started_at",
    [from],
  );
  return rows;
};

describe("anr.beat", () => {
  it("records nothing for beats under 3 minutes apart", async () => {
    expect(await beat(pools.app, name("steady"), at(0))).toBeNull();
    expect(await beat(pools.app, name("steady"), at(2.5))).toBeNull();
    expect(await outages(at(0))).toEqual([]);
  });

  it("records one worker outage, with its start and end, for a worker killed for 4 minutes", async () => {
    const [a, b] = [name("a"), name("b")];
    await beat(pools.app, a, at(10));
    await beat(pools.app, b, at(10));
    await beat(pools.app, b, at(12));
    await beat(pools.app, b, at(14));
    expect(await beat(pools.app, a, at(14.1))).toBe("worker");
    expect(await beat(pools.app, a, at(14.6))).toBeNull();
    expect(await outages(at(10))).toEqual([
      { kind: "worker", worker: a, started_at: at(10), ended_at: at(14.1) },
    ]);
  });

  it("records one host outage when every worker was silent, and no worker outage for it", async () => {
    const [a, b] = [name("c"), name("d")];
    await beat(pools.app, a, at(100));
    await beat(pools.app, b, at(100));
    // Asleep: nobody beats for 4 minutes. Whichever worker wakes first records the host's gap.
    expect(await beat(pools.app, a, at(104))).toBe("host");
    expect(await beat(pools.app, b, at(104.1))).toBeNull();
    expect(await outages(at(100))).toEqual([
      { kind: "host", worker: null, started_at: at(100), ended_at: at(104) },
    ]);
  });
});

describe("health", () => {
  it("is ok only while every worker beat within 3 minutes", async () => {
    for (const w of WORKERS) await beat(pools.app, w);
    expect(await health(pools.app)).toEqual({ ok: true, late: [] });
    await pools.app.query(
      "update heartbeats set beat_at = now() - interval '4 minutes' where worker = 'publisher'",
    );
    expect(await health(pools.app)).toEqual({ ok: false, late: ["publisher"] });
    await pools.migrator.query("delete from heartbeats where worker = 'verifier'");
    expect(await health(pools.app)).toEqual({ ok: false, late: ["publisher", "verifier"] });
  });
});
