// A returned assignment (D96): one new desk run, and an hour's grace from the deadline sweep.
import { recordAudit, withNewsroom } from "@anr/db";
import { createTestNewsroom, testPools } from "@anr/db/testing";
import { afterAll, describe, expect, it } from "vitest";
import { sweepStuck } from "./gate/sweep.ts";
import { redraft } from "./redraft.ts";
import { ModelRouter } from "./router.ts";

const pools = testPools();
afterAll(() => pools.end());

const router = new ModelRouter({
  providers: {},
  models: { writer: { provider: "gemini", model: "writer-model", family: "writer", tools: true } },
  roles: {
    planner: ["writer"],
    desk: { default: ["writer"] },
    renderer: ["writer"],
    "fact-checker": ["writer"],
    "item-matcher": ["writer"],
    summariser: ["writer"],
  },
  tts: "writer",
} as never);

const SLOT = new Date("2026-10-27T18:00:00Z");

async function returned() {
  const newsroomId = await createTestNewsroom(pools.system, "redraft");
  const one = async (sql: string, params: unknown[]) =>
    ((await pools.system.query(sql, params)).rows[0] as { id: string }).id;
  const seriesId = await one(
    `insert into series (newsroom_id, slug, format_id, languages, config)
     select $1, 'daily-newsletter', f.id, '{fa}', '{}' from formats f where f.slug = 'newsletter-issue' returning id`,
    [newsroomId],
  );
  const assignmentId = await one(
    "insert into assignments (newsroom_id, series_id, slot) values ($1, $2, $3) returning id",
    [newsroomId, seriesId, SLOT],
  );
  const publicationId = await one(
    `insert into publications (newsroom_id, series_id, assignment_id, slot, language, status)
     values ($1, $2, $3, $4, 'fa', 'assigned') returning id`,
    [newsroomId, seriesId, assignmentId, SLOT],
  );
  return { newsroomId, assignmentId, publicationId };
}

describe("re-drafting a returned assignment", () => {
  it("starts one desk run, never a second while it is open", async () => {
    const t = await returned();
    const sent: { queue: string }[] = [];
    const boss = { send: async (queue: string) => (sent.push({ queue }), "job") };
    const first = await redraft(pools.app, boss as never, router, t);
    expect(first.kind).toBe("started");
    expect(sent).toEqual([{ queue: "agent-run" }]);
    expect(await redraft(pools.app, boss as never, router, t)).toEqual({
      kind: "skipped",
      reason: "run-open",
    });
    const { rows } = await pools.system.query(
      "select role, model from agent_runs where assignment_id = $1",
      [t.assignmentId],
    );
    expect(rows).toEqual([{ role: "desk", model: "writer-model" }]);
  });

  it("does nothing once nothing is assigned", async () => {
    const t = await returned();
    await pools.system.query("update publications set status = 'drafted' where id = $1", [
      t.publicationId,
    ]);
    const boss = { send: async () => "job" };
    expect(await redraft(pools.app, boss as never, router, t)).toEqual({
      kind: "skipped",
      reason: "nothing-assigned",
    });
  });

  it("is spared by the deadline sweep for an hour after its return, then held", async () => {
    const t = await returned();
    await withNewsroom(pools.app, t.newsroomId, (c) =>
      recordAudit(c, {
        actor: { kind: "code", name: "test" },
        action: "return",
        entity: "publications",
        entityId: t.publicationId,
      }),
    );
    const status = async () =>
      (await pools.system.query("select status from publications where id = $1", [t.publicationId]))
        .rows[0]?.status;
    // Long past its slot, but just returned: it may still be re-drafted.
    await sweepStuck(pools.app, new Date(Date.now() + 5 * 60_000), [t.newsroomId]);
    expect(await status()).toBe("assigned");
    await sweepStuck(pools.app, new Date(Date.now() + 61 * 60_000), [t.newsroomId]);
    expect(await status()).toBe("with-editor");
  });
});
