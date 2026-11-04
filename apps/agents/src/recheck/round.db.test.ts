// A recheck run's rounds on anr_test (D184): what ends a run, and runs a restart cut off.
import type { RecheckJob } from "@anr/core";
import { createTestNewsroom, testPools } from "@anr/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ModelRouter } from "../router.ts";
import { type RoundDeps, recheckRound } from "./round.ts";

const pools = testPools();
afterAll(() => pools.end());

let newsroomId = "";
let next: { job: RecheckJob; after: number }[] = [];
let loaded = true;
let ingestion = true;
const router = new ModelRouter({
  catalog: [],
  roles: { desk: { default: ["m"] }, "fact-checker": [] },
} as never);
const deps = (): RoundDeps => ({
  pool: pools.app,
  boss: { send: async () => "job" },
  router,
  models: { models: {} } as never,
  ingestion: {
    requestSource: async () => {
      throw new Error("no source is requested in these tests");
    },
  },
  makeModel: () => {
    throw new Error("no model is called in these tests");
  },
  gate: {} as never,
  notLoaded: async () => (loaded ? [] : ["gemma (google/gemma-4-12b at http://127.0.0.1:1234/v1)"]),
  ingestionUp: async () => ingestion,
  next: async (job, after) => {
    next.push({ job, after });
  },
  log: () => {},
});
const start = async (): Promise<RecheckJob> => {
  await pools.system.query(
    "update recheck_runs set finished_at = now(), outcome = 'stopped' where newsroom_id = $1 and finished_at is null",
    [newsroomId],
  );
  const { rows } = await pools.system.query<{ id: string }>(
    "insert into recheck_runs (newsroom_id) values ($1) returning id",
    [newsroomId],
  );
  return { newsroomId, recheckRunId: rows[0]?.id ?? "" };
};
const run = async (job: RecheckJob) =>
  (
    await pools.system.query<{ outcome: string | null; detail: string | null; rounds: number }>(
      "select outcome, detail, rounds from recheck_runs where id = $1",
      [job.recheckRunId],
    )
  ).rows[0];

beforeAll(async () => {
  newsroomId = await createTestNewsroom(pools.system, "recheck");
});
beforeEach(() => {
  next = [];
  loaded = true;
  ingestion = true;
});

describe("a recheck round", () => {
  it("is blocked, spending no try, while a local model is not loaded or ingestion is down", async () => {
    loaded = false;
    const job = await start();
    expect(await recheckRound(deps(), job)).toMatch(/^blocked: load these models first: gemma/);
    expect(await run(job)).toMatchObject({ outcome: "blocked", rounds: 0 });

    loaded = true;
    ingestion = false;
    const again = await start();
    await recheckRound(deps(), again);
    expect(await run(again)).toMatchObject({
      outcome: "blocked",
      detail: "ingestion does not answer",
    });
    expect(next).toEqual([]);
  });

  it("stops when a person asked, and does nothing for a run that has ended", async () => {
    const job = await start();
    await pools.system.query("update recheck_runs set stop_requested_at = now() where id = $1", [
      job.recheckRunId,
    ]);
    expect(await recheckRound(deps(), job)).toBe("stopped");
    expect(await recheckRound(deps(), job)).toBe("finished already");
    expect(next).toEqual([]);
  });

  it("finishes runs a restart cut off as failed tries, and is done when nothing is left", async () => {
    const insert = (startedAt: string) =>
      pools.system.query<{ id: string }>(
        `insert into agent_runs (newsroom_id, role, provider, model, prompt_version, input_hash, task, started_at)
         values ($1, 'desk', 'p', 'm', 'v', 'h', '{"key": "recheck", "item": 0}', now() - $2::interval)
         returning id`,
        [newsroomId, startedAt],
      );
    const old = (await insert("2 hours")).rows[0]?.id;
    const live = (await insert("1 minute")).rows[0]?.id;
    const job = await start();
    expect(await recheckRound(deps(), job)).toBe("done");
    const { rows } = await pools.system.query<{
      id: string;
      outcome: string | null;
      detail: unknown;
    }>("select id, outcome, detail from agent_runs where id = any($1)", [[old, live]]);
    expect(rows.find((r) => r.id === old)).toMatchObject({
      outcome: "error",
      detail: { error: "interrupted" },
    });
    expect(rows.find((r) => r.id === live)?.outcome).toBeNull();
    expect(await run(job)).toMatchObject({ outcome: "done", rounds: 1 });
    expect(next).toEqual([]);
  });
});
