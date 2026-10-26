import { QUEUES } from "@anr/core";
import { createTestNewsroom, testPools } from "@anr/db/testing";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { afterAll, describe, expect, it } from "vitest";
import { ModelRouter } from "../router.ts";
import { Throttle } from "../throttle.ts";
import { enqueueSummaries, resumeSummaries, runSummariser, summariserHandler } from "./run.ts";

const pools = testPools();
afterAll(() => pools.end());

const router = new ModelRouter({
  roles: {
    planner: { provider: "gemini", model: "p" },
    desk: { default: { provider: "gemini", model: "d" } },
    renderer: { provider: "gemini", model: "r" },
    "fact-checker": {
      candidates: [
        { provider: "gemini", model: "a" },
        { provider: "gemini", model: "b" },
      ],
    },
    "item-matcher": { provider: "gemini", model: "i" },
    summariser: { provider: "gemini", model: "flash-lite-test" },
  },
  tts: { provider: "gemini", model: "t" },
} as never);

async function setup() {
  const newsroomId = await createTestNewsroom(pools.system, "sum");
  for (const [slug, topics] of [
    ["labs", ["medtop:20001298"]],
    ["research", ["medtop:20001298", "medtop:20000735"]],
  ] as const) {
    await pools.system.query(
      "insert into beats (newsroom_id, slug, status, media_topics) values ($1, $2, 'open', $3)",
      [newsroomId, slug, topics],
    );
  }
  const { rows } = await pools.system.query<{ id: string }>(
    `insert into leads (newsroom_id, uri, headline, body, language, content_hash, tier)
     values ($1, 'https://example.com/orbit', 'Orbit', 'Example Lab released Orbit.', 'en', 'h1', 1)
     returning id`,
    [newsroomId],
  );
  return { newsroomId, leadId: rows[0]?.id ?? "" };
}

describe("summariser runs", () => {
  it("logs an Agent run, queues it in the same transaction, and stores the submit", async () => {
    const { newsroomId, leadId } = await setup();
    const sent: { queue: string; data: unknown; db: unknown }[] = [];
    const boss = {
      send: async (queue: string, data: object, options?: { db?: unknown }) => {
        sent.push({ queue, data, db: options?.db });
        return "job-id";
      },
    };
    const [runId] = await enqueueSummaries(pools.app, boss as never, router, newsroomId, [leadId]);
    expect(sent).toEqual([
      { queue: QUEUES.agentRun, data: { newsroomId, agentRunId: runId }, db: expect.anything() },
    ]);

    const model = new FakeListChatModel({
      responses: ['{"summary": "Orbit is out.", "beats": ["labs"]}'],
    });
    const outcome = await runSummariser(pools.app, () => model, {
      newsroomId,
      agentRunId: runId ?? "",
    });
    expect(outcome).toBe("submitted");

    const lead = await pools.system.query(
      `select l.summary, array_agg(b.slug) as beats, array_agg(t) as topics
       from leads l join lead_beats lb on lb.lead_id = l.id join beats b on b.id = lb.beat_id,
            unnest(b.media_topics) t
       where l.id = $1 group by l.summary`,
      [leadId],
    );
    expect(lead.rows[0]).toMatchObject({ summary: "Orbit is out.", topics: ["medtop:20001298"] });
    const run = await pools.system.query(
      "select role, model, prompt_version, outcome, finished_at is not null as done from agent_runs where id = $1",
      [runId],
    );
    expect(run.rows[0]).toEqual({
      role: "summariser",
      model: "flash-lite-test",
      prompt_version: "summariser-2",
      outcome: "submitted",
      done: true,
    });
    // A retried job finds the run finished and does nothing.
    expect(
      await runSummariser(pools.app, () => model, { newsroomId, agentRunId: runId ?? "" }),
    ).toBeNull();
  });

  it("records an invalid run and stores no summary", async () => {
    const { newsroomId, leadId } = await setup();
    const [runId] = await enqueueSummaries(
      pools.app,
      { send: async () => "x" } as never,
      router,
      newsroomId,
      [leadId],
    );
    const model = new FakeListChatModel({
      responses: ['{"summary": "x", "beats": ["made-up"]}', "nope"],
    });
    expect(
      await runSummariser(pools.app, () => model, { newsroomId, agentRunId: runId ?? "" }),
    ).toBe("invalid");
    const { rows } = await pools.system.query("select summary from leads where id = $1", [leadId]);
    expect(rows[0]).toEqual({ summary: null });
  });
});

describe("summariser queueing with real pg-boss", () => {
  it("commits the run and its job together, or neither", async () => {
    const { createBoss } = await import("@anr/db");
    const { testDatabaseUrl, loadRootEnv } = await import("@anr/db/testing");
    loadRootEnv();
    const boss = createBoss(testDatabaseUrl(process.env.DATABASE_URL ?? ""), "agents-test", {
      supervise: false,
      schedule: false,
    });
    await boss.start();
    try {
      const { newsroomId, leadId } = await setup();
      const [runId] = await enqueueSummaries(pools.app, boss, router, newsroomId, [leadId]);
      const jobs = await pools.system.query(
        "select 1 from pgboss.job where name = $1 and data->>'agentRunId' = $2",
        [QUEUES.agentRun, runId],
      );
      expect(jobs.rowCount).toBe(1);

      // A failure after the send rolls back the run row and the job alike.
      const second = await setup();
      const failingBoss = {
        send: async (...args: Parameters<typeof boss.send>) => {
          await boss.send(...args);
          throw new Error("after send");
        },
      };
      await expect(
        enqueueSummaries(pools.app, failingBoss as never, router, second.newsroomId, [
          second.leadId,
        ]),
      ).rejects.toThrow("after send");
      const runs = await pools.system.query("select id from agent_runs where lead_id = $1", [
        second.leadId,
      ]);
      expect(runs.rowCount).toBe(0);
      const orphanJobs = await pools.system.query(
        "select 1 from pgboss.job where name = $1 and data->>'newsroomId' = $2",
        [QUEUES.agentRun, second.newsroomId],
      );
      expect(orphanJobs.rowCount).toBe(0);
    } finally {
      await boss.stop({ graceful: false });
    }
  });

  it("resumes leads with no run and runs whose job is gone", async () => {
    const { newsroomId, leadId } = await setup();
    const sent: unknown[] = [];
    const boss = {
      send: async (_q: string, data: object) => {
        sent.push(data);
        return "x";
      },
    };
    // The lead has no run at all (its enqueue was lost).
    await resumeSummaries(pools.app, boss as never, router);
    const mine = sent.filter((d) => (d as { newsroomId: string }).newsroomId === newsroomId);
    expect(mine).toHaveLength(1);
    // Now it has a run with no outcome and no job: resumed by resending, not a second run.
    sent.length = 0;
    await resumeSummaries(pools.app, boss as never, router);
    const again = sent.filter((d) => (d as { newsroomId: string }).newsroomId === newsroomId);
    expect(again).toHaveLength(1);
    const runs = await pools.system.query("select id from agent_runs where lead_id = $1", [leadId]);
    expect(runs.rowCount).toBe(1);
  });
});

describe("summariserHandler", () => {
  it("re-queues a rate-limited run for later instead of failing it", async () => {
    const { newsroomId, leadId } = await setup();
    const [runId] = await enqueueSummaries(
      pools.app,
      { send: async () => "x" } as never,
      router,
      newsroomId,
      [leadId],
    );
    const job = { newsroomId, agentRunId: runId ?? "" };
    const sent: { data: unknown; options: unknown }[] = [];
    const boss = {
      send: async (_q: string, data: object, options?: object) => {
        sent.push({ data, options });
        return "x";
      },
    };
    let now = 0;
    const throttle = new Throttle(
      6000,
      () => now,
      async (ms) => {
        now += ms;
      },
    );
    const limited = {
      invoke: async () => {
        throw Object.assign(new Error("429 Too Many Requests"), {
          errorDetails: [{ retryDelay: "40s" }],
        });
      },
    };
    const handle = summariserHandler({
      pool: pools.app,
      boss: boss as never,
      makeModel: () => limited as never,
      throttle,
      log: () => {},
    });
    await handle(job); // completes, so pg-boss spends no retry on it
    expect(sent).toEqual([{ data: job, options: { startAfter: 40 } }]);
    const { rows } = await pools.system.query("select outcome from agent_runs where id = $1", [
      runId,
    ]);
    expect(rows[0]).toEqual({ outcome: null });
    // While paused, the next job is queued for later without calling the model.
    await handle(job);
    expect(sent[1]).toEqual({ data: job, options: { startAfter: 40 } });
  });
});
