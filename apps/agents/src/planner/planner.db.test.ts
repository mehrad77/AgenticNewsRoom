// Planning tick → planner run → themes and picks → deadline or pick → assignment, on anr_test with
// a scripted model (D103, D104).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { QUEUES } from "@anr/core";
import { createTestNewsroom, testPools } from "@anr/db/testing";
import { AIMessage } from "@langchain/core/messages";
import type { PgBoss } from "pg-boss";
import { afterAll, describe, expect, it } from "vitest";
import { assignPick } from "../assign.ts";
import type { RoleDeps } from "../desk/run.ts";
import { type ChatLike, meteredChat } from "../model.ts";
import { ModelRouter } from "../router.ts";
import { pickDeadline } from "./deadline.ts";
import { plannerPrompt, runPlanner } from "./run.ts";
import { planTick } from "./tick.ts";
import { cycleWeeks } from "./validate.ts";

const pools = testPools();
afterAll(() => pools.end());

const configDir = fileURLToPath(new URL("../../../../config", import.meta.url));
/** Wednesday 28 October 2026, 09:00 in Istanbul: four days before the first cycle. */
const BEFORE_CYCLE = new Date("2026-10-28T06:00:00Z");
/** Monday 2 November, 09:00 in Istanbul: the classic paper's proposal day. */
const MONDAY = new Date("2026-11-02T06:00:00Z");

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

function scripted(answers: string[]): ChatLike {
  return {
    async invoke() {
      const next = answers.shift();
      if (next === undefined) throw new Error("no more answers");
      return new AIMessage({
        content: next,
        usage_metadata: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      });
    },
  };
}

async function setup() {
  const newsroomId = await createTestNewsroom(pools.system, "plan");
  const { rows: n } = await pools.system.query<{ slug: string }>(
    `update newsrooms set languages = '{fa,en}', timezone = 'Europe/Istanbul',
            planning = '{"cycle": "1mo", "from": "2026-11-01"}',
            policy = '{"budget": {"monthly_usd": 30, "check_reserve_usd": 3}}'
     where id = $1 returning slug`,
    [newsroomId],
  );
  const slug = n[0]?.slug ?? "";
  const dir = mkdtempSync(join(tmpdir(), "anr-plan-"));
  mkdirSync(join(dir, "newsrooms", slug), { recursive: true });
  writeFileSync(
    join(dir, "newsrooms", slug, "style.md"),
    readFileSync(join(configDir, "newsrooms/ai/style.md")),
  );

  const beat = async (s: string, status: string) =>
    (
      await pools.system.query<{ id: string }>(
        `insert into beats (newsroom_id, slug, status, media_topics) values ($1, $2, $3, '{medtop:20001298}') returning id`,
        [newsroomId, s, status],
      )
    ).rows[0]?.id ?? "";
  const labs = await beat("labs", "open");
  const gossip = await beat("gossip", "banned");
  const { rows: s } = await pools.system.query<{ id: string }>(
    `insert into series (newsroom_id, slug, format_id, languages, config)
     select $1, 'weekly-classic', f.id, '{fa,en}',
            '{"cadence": {"weekly": "wed 10:00"}, "pick": {"planner_proposes": 3, "by": "mon", "editor_picks_by": "tue"}}'
     from formats f where f.slug = 'classic-article' returning id`,
    [newsroomId],
  );
  const seriesId = s[0]?.id ?? "";
  const lead = async (key: string, beatId: string) => {
    const { rows } = await pools.system.query<{ id: string }>(
      `insert into leads (newsroom_id, uri, headline, body, language, content_hash, tier, summary, fetched_at)
       values ($1, $2, $3, 'Attention is all you need, the paper said.', 'en', md5($2), 1, $4, $5)
       returning id`,
      [newsroomId, `https://arxiv.example/${key}`, `Paper ${key}`, `Summary ${key}`, BEFORE_CYCLE],
    );
    const id = rows[0]?.id ?? "";
    await pools.system.query(
      "insert into lead_beats (newsroom_id, lead_id, beat_id) values ($1, $2, $3)",
      [newsroomId, id, beatId],
    );
    return id;
  };
  const leads = {
    a: await lead("a", labs),
    b: await lead("b", labs),
    c: await lead("c", labs),
    banned: await lead("banned", gossip),
  };

  const sent: { queue: string; data: Record<string, string>; options?: Record<string, unknown> }[] =
    [];
  const boss = {
    send: async (queue: string, data: object, options?: Record<string, unknown>) => {
      sent.push({ queue, data: data as Record<string, string>, options });
      return "job";
    },
  } as unknown as Pick<PgBoss, "send">;
  const answers: string[] = [];
  const deps: RoleDeps = {
    pool: pools.app,
    boss,
    router,
    configDir: dir,
    makeModel: (_chain, tokenCap) => meteredChat(scripted(answers), "writer", { tokenCap }),
    ingestion: { requestSource: async () => ({ kind: "failed", detail: "offline" }) },
    log: () => {},
  };
  const q = async <T extends object>(sql: string, params: unknown[] = []) =>
    (await pools.system.query<T>(sql, [newsroomId, ...params])).rows;
  return { newsroomId, slug, seriesId, leads, sent, boss, answers, deps, q };
}

const weeks = cycleWeeks({ starts: "2026-11-01", ends: "2026-12-01" });
const themes = (leadId: string) =>
  JSON.stringify({
    themes: ["Open weights", "Small models"].map((theme) => ({
      theme,
      angle: `${theme}: who builds them and who can check them.`,
      rationale: "The pool is full of it.",
      calendar: weeks.map((week) => ({ week, focus: `${theme} in week ${week}` })),
      lead_ids: [leadId],
    })),
  });
const candidates = (ids: string[]) =>
  JSON.stringify({
    candidates: ids.map((id, i) => ({
      title: `Classic paper ${i}`,
      angle: "The paper and what came of it.",
      why: "It fits the theme.",
      lead_ids: [id],
    })),
  });

describe("planning (D103, D104)", () => {
  it("fits the planner's prompt in 5 KB for every newsroom", () => {
    for (const newsroom of ["ai", "kultur"]) {
      expect(plannerPrompt(configDir, newsroom).bytes).toBeLessThanOrEqual(5 * 1024);
    }
  });

  it("proposes themes a week ahead, once, from stored leads only", async () => {
    const t = await setup();
    const ticked = await planTick(
      pools.app,
      t.boss,
      router,
      { newsroomId: t.newsroomId },
      BEFORE_CYCLE,
    );
    expect(ticked).toEqual([
      { kind: "themes", key: "themes:2026-11-01", runId: expect.any(String) },
    ]);
    const runId = ticked[0]?.kind === "themes" ? ticked[0].runId : "";
    expect(t.sent.map((s) => s.queue)).toEqual([QUEUES.agentRun]);
    // A second firing (missed: once) starts nothing new.
    expect(
      await planTick(pools.app, t.boss, router, { newsroomId: t.newsroomId }, BEFORE_CYCLE),
    ).toEqual([]);

    // A theme resting on a banned beat's lead is sent back once with the reason.
    t.answers.push(themes(t.leads.banned), themes(t.leads.a));
    expect(
      await runPlanner(t.deps, { newsroomId: t.newsroomId, agentRunId: runId }, BEFORE_CYCLE),
    ).toBe("submitted");
    expect(t.answers).toEqual([]);
    const rows = await t.q<{
      theme: string;
      status: string;
      lead_ids: string[];
      calendar: unknown[];
    }>(
      "select theme, status, lead_ids, calendar from editorial_cycles where newsroom_id = $1 order by theme",
    );
    expect(rows.map((r) => [r.theme, r.status, r.lead_ids, r.calendar.length])).toEqual([
      ["Open weights", "proposed", [t.leads.a], 6],
      ["Small models", "proposed", [t.leads.a], 6],
    ]);
    const [run] = await t.q<{ outcome: string; prompt_version: string }>(
      "select outcome, prompt_version from agent_runs where newsroom_id = $1 and role = 'planner'",
    );
    expect(run?.outcome).toBe("submitted");
    expect(run?.prompt_version).toMatch(/^planner-[0-9a-f]{12}$/);
  });

  it("tells the Editor-in-Chief when the planner cannot propose", async () => {
    const t = await setup();
    const [tick] = await planTick(
      pools.app,
      t.boss,
      router,
      { newsroomId: t.newsroomId },
      BEFORE_CYCLE,
    );
    const runId = tick?.kind === "themes" ? tick.runId : "";
    t.answers.push("not json", '{"themes": []}');
    expect(
      await runPlanner(t.deps, { newsroomId: t.newsroomId, agentRunId: runId }, BEFORE_CYCLE),
    ).toBe("invalid");
    expect(await t.q("select kind, key from notices where newsroom_id = $1")).toEqual([
      { kind: "plan-failed", key: "themes:2026-11-01" },
    ]);
    // The next tick tries again.
    const again = await planTick(
      pools.app,
      t.boss,
      router,
      { newsroomId: t.newsroomId },
      BEFORE_CYCLE,
    );
    expect(again.map((o) => o.kind)).toEqual(["themes"]);
  });

  it("closes a planner run that never finished and starts its task again", async () => {
    const t = await setup();
    const [tick] = await planTick(
      pools.app,
      t.boss,
      router,
      { newsroomId: t.newsroomId },
      BEFORE_CYCLE,
    );
    const runId = tick?.kind === "themes" ? tick.runId : "";
    await pools.system.query(
      "update agent_runs set started_at = now() - interval '3 hours' where id = $1",
      [runId],
    );
    const again = await planTick(
      pools.app,
      t.boss,
      router,
      { newsroomId: t.newsroomId },
      BEFORE_CYCLE,
    );
    expect(again.map((o) => o.kind)).toEqual(["themes"]);
    expect(
      await t.q("select outcome from agent_runs where newsroom_id = $1 and id = $2", [runId]),
    ).toEqual([{ outcome: "timed-out" }]);
    expect(await t.q("select kind, key from notices where newsroom_id = $1")).toEqual([
      { kind: "plan-failed", key: "themes:2026-11-01" },
    ]);
  });

  it("spends nothing on candidates whose deadline has passed", async () => {
    const t = await setup();
    await pools.system.query(
      `insert into editorial_cycles (newsroom_id, starts, ends, theme, status, decided_at)
       values ($1, '2026-11-01', '2026-12-01', 'Open weights', 'approved', now())`,
      [t.newsroomId],
    );
    const [tick] = await planTick(pools.app, t.boss, router, { newsroomId: t.newsroomId }, MONDAY);
    const runId = tick?.kind === "candidates" ? tick.runId : "";
    const late = new Date("2026-11-03T21:30:00Z");
    expect(
      await runPlanner(t.deps, { newsroomId: t.newsroomId, agentRunId: runId }, late),
    ).toBeNull();
    expect(
      await t.q("select outcome from agent_runs where newsroom_id = $1 and id = $2", [runId]),
    ).toEqual([{ outcome: "timed-out" }]);
    expect(await t.q("select count(*)::int as n from picks where newsroom_id = $1")).toEqual([
      { n: 0 },
    ]);
  });

  it("waits for an approved theme, then proposes three candidates with their deadline", async () => {
    const t = await setup();
    // The cycle has begun with nothing approved: no candidates, and one notice.
    expect(await planTick(pools.app, t.boss, router, { newsroomId: t.newsroomId }, MONDAY)).toEqual(
      [
        { kind: "themes", key: "themes:2026-11-01", runId: expect.any(String) },
        { kind: "no-theme", starts: "2026-11-01" },
      ],
    );
    const { rows: cycle } = await pools.system.query<{ id: string }>(
      `insert into editorial_cycles (newsroom_id, starts, ends, theme, angle, calendar, status, decided_at)
       values ($1, '2026-11-01', '2026-12-01', 'Open weights', 'Who builds them.',
               '[{"week": "2026-11-02", "focus": "Transformers"}]', 'approved', now()) returning id`,
      [t.newsroomId],
    );
    t.sent.length = 0;
    const [tick] = await planTick(pools.app, t.boss, router, { newsroomId: t.newsroomId }, MONDAY);
    expect(tick).toEqual({
      kind: "candidates",
      key: "candidates:weekly-classic:2026-11-02",
      runId: expect.any(String),
    });
    const runId = tick?.kind === "candidates" ? tick.runId : "";
    const [task] = await t.q<{ task: Record<string, string> }>(
      "select task from agent_runs where newsroom_id = $1 and id = $2",
      [runId],
    );
    expect(task?.task).toMatchObject({
      cycle_id: cycle[0]?.id,
      week: "2026-11-02",
      slot: "2026-11-04T07:00:00.000Z",
      deadline: "2026-11-03T21:00:00.000Z",
    });

    t.answers.push(candidates([t.leads.a, t.leads.b, t.leads.c]));
    t.sent.length = 0;
    expect(await runPlanner(t.deps, { newsroomId: t.newsroomId, agentRunId: runId }, MONDAY)).toBe(
      "submitted",
    );
    const [pick] = await t.q<{ id: string; candidates: { title: string }[]; slot: Date }>(
      "select id, candidates, slot from picks where newsroom_id = $1",
    );
    expect(pick?.candidates.map((c) => c.title)).toEqual([
      "Classic paper 0",
      "Classic paper 1",
      "Classic paper 2",
    ]);
    // The deadline is a job, queued with the candidates (D104).
    expect(t.sent).toEqual([
      {
        queue: QUEUES.pickDeadline,
        data: { newsroomId: t.newsroomId, pickId: pick?.id },
        options: expect.objectContaining({ startAfter: new Date("2026-11-03T21:00:00Z") }),
      },
    ]);
  });

  async function proposedPick() {
    const t = await setup();
    const { rows: cycle } = await pools.system.query<{ id: string }>(
      `insert into editorial_cycles (newsroom_id, starts, ends, theme, status, decided_at)
       values ($1, '2026-11-01', '2026-12-01', 'Open weights', 'approved', now()) returning id`,
      [t.newsroomId],
    );
    const { rows } = await pools.system.query<{ id: string }>(
      `insert into picks (newsroom_id, cycle_id, series_id, week, candidates, deadline, slot)
       values ($1, $2, $3, '2026-11-02', $4, '2026-11-03T21:00:00Z', '2026-11-04T07:00:00Z') returning id`,
      [
        t.newsroomId,
        cycle[0]?.id,
        t.seriesId,
        JSON.stringify(JSON.parse(candidates([t.leads.a, t.leads.b, t.leads.banned])).candidates),
      ],
    );
    return { t, pickId: rows[0]?.id ?? "", cycleId: cycle[0]?.id ?? "" };
  }

  it("skips the slot at the deadline when nothing was chosen", async () => {
    const { t, pickId } = await proposedPick();
    const job = { newsroomId: t.newsroomId, pickId };
    expect(await pickDeadline(pools.app, t.boss, job, new Date("2026-11-03T20:00:00Z"))).toBe(
      "early",
    );
    expect(await pickDeadline(pools.app, t.boss, job, new Date("2026-11-03T21:00:00Z"))).toBe(
      "skipped",
    );
    expect(await pickDeadline(pools.app, t.boss, job, new Date("2026-11-03T21:05:00Z"))).toBe(
      "decided",
    );
    expect(await t.q("select kind, key from notices where newsroom_id = $1")).toEqual([
      { kind: "pick-missed", key: pickId },
    ]);
    expect(await t.q("select action, entity from audit_log where newsroom_id = $1")).toEqual([
      { action: "skip", entity: "picks" },
    ]);
    expect(
      await assignPick(pools.app, t.boss, router, { ...job, seriesId: t.seriesId }, MONDAY),
    ).toEqual({ kind: "not-chosen" });
  });

  it("assigns a chosen pick as themed work, with its candidate's angle and leads", async () => {
    const { t, pickId, cycleId } = await proposedPick();
    await pools.system.query("update picks set chosen = 2, picked_at = now() where id = $1", [
      pickId,
    ]);
    const job = { newsroomId: t.newsroomId, seriesId: t.seriesId, pickId };
    const outcome = await assignPick(pools.app, t.boss, router, job, MONDAY);
    // The chosen candidate's only lead is in a banned beat now: nothing to research from.
    expect(outcome).toEqual({ kind: "no-leads", slot: "2026-11-04T07:00:00.000Z" });

    await pools.system.query("update picks set chosen = 0 where id = $1", [pickId]);
    const assigned = await assignPick(pools.app, t.boss, router, job, MONDAY);
    expect(assigned).toMatchObject({ kind: "assigned", leads: 1 });
    const [a] = await t.q<{ cycle_id: string; pick_id: string; angle: string; leads: string[] }>(
      `select a.cycle_id, a.pick_id, a.angle,
              array(select lead_id from assignment_leads al where al.assignment_id = a.id) as leads
       from assignments a where a.newsroom_id = $1`,
    );
    expect(a).toEqual({
      cycle_id: cycleId,
      pick_id: pickId,
      angle: "Classic paper 0. The paper and what came of it.",
      leads: [t.leads.a],
    });
    expect(
      await t.q(
        "select language, status from publications where newsroom_id = $1 order by language",
      ),
    ).toEqual([
      { language: "en", status: "assigned" },
      { language: "fa", status: "assigned" },
    ]);
    expect(await assignPick(pools.app, t.boss, router, job, MONDAY)).toMatchObject({
      kind: "exists",
    });
    expect(
      await pickDeadline(pools.app, t.boss, { newsroomId: t.newsroomId, pickId }, MONDAY),
    ).toBe("decided");
  });
});
