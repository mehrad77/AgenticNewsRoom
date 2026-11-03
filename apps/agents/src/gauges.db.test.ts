// Platform gauges on anr_test (D139, D158): each newsroom's numbers are read under its own tenancy
// setting, so two newsrooms with different rows see only their own; the platform's are read once.
import { createTestNewsroom, testPools } from "@anr/db/testing";
import { recordTelemetry } from "@anr/telemetry/testing";
import { metrics } from "@opentelemetry/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectNewsroom, collectPlatform, observeGauges, type Snapshot } from "./gauges.ts";

const pools = testPools();
afterAll(() => pools.end());

const one = async (sql: string, params: unknown[]) =>
  ((await pools.system.query(sql, params)).rows[0] as { id: string }).id;

/** A newsroom with publications in each slot outcome; `n` scales its counts apart. */
async function seed(prefix: string, n: number): Promise<string> {
  const newsroomId = await createTestNewsroom(pools.system, prefix);
  // Grace of the newsletter format: 30 minutes unless config sync set another.
  const series = await one(
    `insert into series (newsroom_id, slug, format_id, languages, config)
     select $1, 'daily', f.id, '{en}', '{}' from formats f where f.slug = 'newsletter-issue'
     returning id`,
    [newsroomId],
  );
  const publication = async (
    day: number,
    publishedAfter: string | null,
    status: string,
    late: boolean | null = null,
  ) => {
    const slot = new Date(Date.UTC(2031, 0, day, 7));
    const assignment = await one(
      "insert into assignments (newsroom_id, series_id, slot) values ($1, $2, $3) returning id",
      [newsroomId, series, slot],
    );
    return one(
      `insert into publications (newsroom_id, series_id, assignment_id, slot, language, status,
                                 published_at, published_late)
       values ($1, $2, $3, $4, 'en', $5, $4::timestamptz + $6::interval, $7) returning id`,
      [newsroomId, series, assignment, slot, status, publishedAfter, late],
    );
  };
  let day = 1;
  for (let i = 0; i < n; i++) await publication(day++, "5 minutes", "published");
  // Late by today's grace; within the grace it had when sent, which is what counts (D158).
  await publication(day++, "2 hours", "published", false);
  // Sent before published_late existed: compared with the grace.
  await publication(day++, "3 hours", "published");
  // Missed past its grace, then sent by an editor: counted once, as missed.
  const missedThenSent = await publication(day++, "5 hours", "published");
  const held = await publication(day++, null, "with-editor");
  for (const id of [missedThenSent, held]) {
    await pools.system.query(
      `insert into notices (newsroom_id, kind, key) values ($1, 'slot-missed', $2)`,
      [newsroomId, id],
    );
    await pools.system.query(
      `insert into checks (newsroom_id, publication_id, kind, name, result)
       values ($1, $2, 'policy', 'missed-slot', 'timed-out')`,
      [newsroomId, id],
    );
    await pools.system.query(
      `insert into audit_log (newsroom_id, actor_kind, actor_name, action, entity, entity_id)
       values ($1, 'code', 'publisher', 'hold', 'publications', $2)`,
      [newsroomId, id],
    );
  }
  // A slot an outage left unassigned.
  await pools.system.query(
    `insert into notices (newsroom_id, kind, key) values ($1, 'slot-missed', 'daily:2031-02-01')`,
    [newsroomId],
  );
  await pools.system.query(
    `insert into agent_runs (newsroom_id, role, provider, model, prompt_version, input_hash,
                             cost_usd, outcome)
     values ($1, 'desk', 'p', 'm', 'v1', 'h', $2, 'submitted')`,
    [newsroomId, n * 1.5],
  );
  return newsroomId;
}

let first = "";
let second = "";
beforeAll(async () => {
  first = await seed("gauge-a", 2);
  second = await seed("gauge-b", 5);
});

describe("platform gauges", () => {
  it("reads each newsroom under its own setting", async () => {
    const a = await collectNewsroom(pools.app, first);
    const b = await collectNewsroom(pools.app, second);
    expect(a).toMatchObject({
      slots: { onTime: 3, late: 1, missed: 3 },
      holds: 2,
      holdReasons: { "missed-slot": 2 },
      withEditor: 1,
      spentUsd: 3,
      budgetUsd: 1000,
    });
    expect(a.slug).toMatch(/^gauge-a-/);
    expect(b).toMatchObject({ slots: { onTime: 6, late: 1, missed: 3 }, spentUsd: 7.5 });
    expect(b.slug).toMatch(/^gauge-b-/);
  });

  it("relies on row-level security, not on a filter: outside a newsroom the query is refused", async () => {
    await expect(pools.app.query("select count(*) from publications")).rejects.toThrow(
      "anr.newsroom_id is not set",
    );
  });

  it("reads the platform's numbers as the app role", async () => {
    const platform = await collectPlatform(pools.app);
    expect(platform.postgresBytes).toBeGreaterThan(0);
    expect(Object.keys(platform.backups).sort()).toEqual(["check", "diff", "full"]);
  });
});

describe("the instruments", () => {
  it("report the snapshot under pinned names, every slot outcome and drainable queue", async () => {
    const telemetry = recordTelemetry();
    const snapshot: Snapshot = {
      at: 1_900_000_000,
      platform: {
        oldestJobAge: { gate: 42 },
        drained: ["plan"],
        heartbeatAge: { agents: 12 },
        outages: { host: { count: 1, seconds: 600 } },
        backups: { check: { lastOk: false, lastSuccess: 1_899_990_000 } },
        wal: { ageSeconds: 30, ok: true, failed: 0 },
        postgresBytes: 1024,
      },
      newsrooms: [
        {
          slug: "ai",
          slots: { onTime: 3, late: 0, missed: 0 },
          holds: 1,
          holdReasons: { "fact-check": 1 },
          withEditor: 0,
          spentUsd: 2,
          budgetUsd: 50,
        },
      ],
      failed: ["kultur"],
    };
    observeGauges(() => snapshot, metrics.getMeter("test"));
    const recorded = await telemetry.metrics();
    const value = (name: string, attributes: Record<string, string> = {}) =>
      recorded
        .get(name)
        ?.dataPoints.find((p) =>
          Object.entries(attributes).every(([k, v]) => p.attributes[k] === v),
        )?.value;
    expect(value("anr.slots", { "anr.newsroom": "ai", "anr.slot.outcome": "missed" })).toBe(0);
    expect(value("anr.slots", { "anr.newsroom": "ai", "anr.slot.outcome": "on-time" })).toBe(3);
    expect(value("anr.queue.oldest_age", { "anr.queue": "gate" })).toBe(42);
    expect(value("anr.queue.oldest_age", { "anr.queue": "plan" })).toBe(0);
    expect(value("anr.queue.drained", { "anr.queue": "plan" })).toBe(1);
    expect(value("anr.outages", { "anr.outage.kind": "worker" })).toBe(0);
    expect(value("anr.backup.last_ok", { "anr.backup.kind": "check" })).toBe(0);
    expect(value("anr.wal.ok")).toBe(1);
    expect(value("anr.gauges.collected")).toBe(1_900_000_000);
    expect(value("anr.spend.month_usd", { "anr.newsroom": "ai" })).toBe(2);
    expect(value("anr.gauges.newsroom_ok", { "anr.newsroom": "ai" })).toBe(1);
    expect(value("anr.gauges.newsroom_ok", { "anr.newsroom": "kultur" })).toBe(0);
  });
});
