// Assignment → desk → renderer → gate job, on anr_test with scripted models.
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { QUEUES } from "@anr/core";
import { createTestNewsroom, testPools } from "@anr/db/testing";
import { AIMessage } from "@langchain/core/messages";
import type { PgBoss } from "pg-boss";
import { afterAll, describe, expect, it } from "vitest";
import { assignDaily } from "../assign.ts";
import { type ChatLike, meteredChat } from "../model.ts";
import { runRenderer } from "../renderer/run.ts";
import { ModelRouter } from "../router.ts";
import { type RoleDeps, runDesk } from "./run.ts";

const pools = testPools();
afterAll(() => pools.end());

const configDir = fileURLToPath(new URL("../../../../config", import.meta.url));
/** 16:00 in Istanbul: the AI newsletter's assignment time (D12). */
const NOW = new Date("2026-10-27T13:00:00Z");

const router = new ModelRouter({
  providers: {},
  models: {
    writer: { provider: "gemini", model: "writer-model", family: "writer", tools: true },
    checker: { provider: "groq", model: "checker-model", family: "checker", tools: true },
  },
  roles: {
    planner: ["writer"],
    desk: { default: ["writer"] },
    renderer: ["writer"],
    "fact-checker": ["writer", "checker"],
    "item-matcher": ["checker"],
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

async function setup(spent = 0) {
  const newsroomId = await createTestNewsroom(pools.system, "desk");
  const { rows: n } = await pools.system.query<{ slug: string }>(
    `update newsrooms set languages = '{fa,en}', timezone = 'Europe/Istanbul',
            policy = '{"budget": {"monthly_usd": 30, "check_reserve_usd": 3}}'
     where id = $1 returning slug`,
    [newsroomId],
  );
  const slug = n[0]?.slug ?? "";
  // The newsroom's config folder: its style guide, and the shared formats.
  const dir = mkdtempSync(join(tmpdir(), "anr-desk-"));
  mkdirSync(join(dir, "newsrooms", slug), { recursive: true });
  writeFileSync(
    join(dir, "newsrooms", slug, "style.md"),
    readFileSync(join(configDir, "newsrooms/ai/style.md")),
  );
  symlinkSync(join(configDir, "formats"), join(dir, "formats"));

  const beat = async (s: string, status: string) =>
    (
      await pools.system.query<{ id: string }>(
        `insert into beats (newsroom_id, slug, status, media_topics) values ($1, $2, $3, '{medtop:20001298}') returning id`,
        [newsroomId, s, status],
      )
    ).rows[0]?.id;
  const labs = await beat("labs", "open");
  const gossip = await beat("gossip", "banned");
  const { rows: s } = await pools.system.query<{ id: string }>(
    `insert into series (newsroom_id, slug, format_id, languages, config)
     select $1, 'daily-newsletter', f.id, '{fa,en}',
            '{"cadence": {"daily": "21:00"}, "assignment_at": "16:00", "items": {"news": "1-2"}}'
     from formats f where f.slug = 'newsletter-issue' returning id`,
    [newsroomId],
  );
  const seriesId = s[0]?.id ?? "";

  const lead = async (
    key: string,
    o: { tier: number; hoursAgo: number; summary?: boolean; beat?: string; withdrawn?: boolean },
  ) => {
    const { rows } = await pools.system.query<{ id: string }>(
      `insert into leads (newsroom_id, uri, headline, body, language, content_hash, tier, summary, fetched_at,
                          withdrawn_at, withdrawn_reason)
       values ($1, $2, $3, $4, 'en', md5($2), $5, $6, $7::timestamptz - make_interval(hours => $8),
               $9, $10) returning id`,
      [
        newsroomId,
        `https://lab.example/${key}`,
        `Lead ${key}`,
        `Example Lab released Orbit ${key}. It is 40 percent faster than Comet, the lab said.`,
        o.tier,
        o.summary === false ? null : `Summary ${key}`,
        NOW,
        o.hoursAgo,
        o.withdrawn ? NOW : null,
        o.withdrawn ? "withdrawn on arXiv" : null,
      ],
    );
    const id = rows[0]?.id ?? "";
    if (o.beat) {
      await pools.system.query(
        "insert into lead_beats (newsroom_id, lead_id, beat_id) values ($1, $2, $3)",
        [newsroomId, id, o.beat],
      );
    }
    return id;
  };
  const ids = {
    best: await lead("best", { tier: 1, hoursAgo: 2, beat: labs }),
    second: await lead("second", { tier: 2, hoursAgo: 1 }),
    banned: await lead("banned", { tier: 1, hoursAgo: 1, beat: gossip }),
    unsummarised: await lead("unsummarised", { tier: 1, hoursAgo: 1, summary: false }),
    withdrawn: await lead("withdrawn", { tier: 1, hoursAgo: 1, withdrawn: true }),
    old: await lead("old", { tier: 1, hoursAgo: 30 }),
  };
  if (spent > 0) {
    await pools.system.query(
      `insert into agent_runs (newsroom_id, role, provider, model, prompt_version, input_hash, cost_usd, outcome)
       values ($1, 'summariser', 'p', 'm', 'v', 'h', $2, 'submitted')`,
      [newsroomId, spent],
    );
  }

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
  const publications = async () =>
    (
      await pools.system.query<{ language: string; status: string }>(
        "select language, status from publications where newsroom_id = $1 order by language",
        [newsroomId],
      )
    ).rows;
  return { newsroomId, seriesId, ids, boss, sent, answers, deps, publications };
}

const valid = (leadId: string, language: string, story = true) =>
  JSON.stringify({
    ...(story && {
      story: {
        summary: "Orbit is out.",
        beat: "labs",
        claims: [
          {
            id: "c1",
            kind: "fact",
            text: "Orbit is 40 percent faster than Comet.",
            lead_id: leadId,
            quoted_passage: "It is 40 percent faster than Comet",
          },
        ],
      },
    }),
    rendition: {
      language,
      title: language === "fa" ? "خبرنامه" : "Newsletter",
      items: [{ kind: "news", headline: "Orbit", body: "Orbit is 40% faster.", claim_ids: ["c1"] }],
    },
  });

describe("daily assignment and the desk (D81, D77)", () => {
  it("assigns the last day's leads by tier, writes, renders and queues the gate", async () => {
    const t = await setup();
    const assigned = await assignDaily(
      pools.app,
      t.boss,
      router,
      { newsroomId: t.newsroomId, seriesId: t.seriesId },
      NOW,
    );
    expect(assigned).toMatchObject({ kind: "assigned", leads: 2 });
    if (assigned.kind !== "assigned") return;
    const { rows: leads } = await pools.system.query<{ lead_id: string }>(
      "select lead_id from assignment_leads where assignment_id = $1",
      [assigned.assignmentId],
    );
    expect(leads.map((l) => l.lead_id).sort()).toEqual([t.ids.best, t.ids.second].sort());
    expect(await t.publications()).toEqual([
      { language: "en", status: "assigned" },
      { language: "fa", status: "assigned" },
    ]);
    // The schedule firing twice makes nothing new.
    expect(
      await assignDaily(
        pools.app,
        t.boss,
        router,
        { newsroomId: t.newsroomId, seriesId: t.seriesId },
        NOW,
      ),
    ).toMatchObject({
      kind: "exists",
    });

    t.answers.push("{}", "{}", valid(t.ids.best, "fa"));
    expect(await runDesk(t.deps, { newsroomId: t.newsroomId, agentRunId: assigned.runId })).toBe(
      "submitted",
    );
    expect(await t.publications()).toEqual([
      { language: "en", status: "assigned" },
      { language: "fa", status: "drafted" },
    ]);
    const { rows: runs } = await pools.system.query<{
      role: string;
      outcome: string | null;
      families: string[];
      tokens_in: number;
      prompt_version: string;
      id: string;
    }>(
      "select id, role, outcome, families, tokens_in, prompt_version from agent_runs where newsroom_id = $1 order by started_at",
      [t.newsroomId],
    );
    expect(runs[0]).toMatchObject({
      role: "desk",
      outcome: "submitted",
      families: ["writer"],
      tokens_in: 300,
    });
    expect(runs[0]?.prompt_version).toMatch(/^desk-[0-9a-f]{12}$/);
    const renderer = runs.find((r) => r.role === "renderer");
    expect(renderer?.outcome).toBeNull();
    const { rows: claims } = await pools.system.query(
      "select ref, kind, lead_id from claims where newsroom_id = $1",
      [t.newsroomId],
    );
    expect(claims).toEqual([{ ref: "c1", kind: "fact", lead_id: t.ids.best }]);

    t.answers.push(valid(t.ids.best, "en", false));
    expect(
      await runRenderer(t.deps, { newsroomId: t.newsroomId, agentRunId: renderer?.id ?? "" }),
    ).toBe("submitted");
    expect(await t.publications()).toEqual([
      { language: "en", status: "drafted" },
      { language: "fa", status: "drafted" },
    ]);
    const gate = t.sent.filter((s) => s.queue === QUEUES.gate);
    expect(gate).toHaveLength(1);
    expect(gate[0]?.options?.singletonKey).toBeTruthy();
    // A retried job finds the run finished and writes nothing more.
    expect(
      await runDesk(t.deps, { newsroomId: t.newsroomId, agentRunId: assigned.runId }),
    ).toBeNull();
  });

  it("holds the assignment with the errors after a second invalid draft", async () => {
    const t = await setup();
    const assigned = await assignDaily(
      pools.app,
      t.boss,
      router,
      { newsroomId: t.newsroomId, seriesId: t.seriesId },
      NOW,
    );
    if (assigned.kind !== "assigned") throw new Error("not assigned");
    t.answers.push("{}", "{}", valid(t.ids.withdrawn, "fa"), valid(t.ids.withdrawn, "fa"));
    expect(await runDesk(t.deps, { newsroomId: t.newsroomId, agentRunId: assigned.runId })).toBe(
      "invalid",
    );
    expect(await t.publications()).toEqual([
      { language: "en", status: "with-editor" },
      { language: "fa", status: "with-editor" },
    ]);
    const { rows } = await pools.system.query<{
      name: string;
      result: string;
      detail: { errors: string[] };
    }>("select name, result, detail from checks where newsroom_id = $1", [t.newsroomId]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: "desk-invalid", result: "fail" });
    expect(rows[0]?.detail.errors[0]).toMatch(/was not given or read/);
    const { rows: audit } = await pools.system.query(
      "select action from audit_log where newsroom_id = $1",
      [t.newsroomId],
    );
    expect(audit).toEqual([{ action: "hold" }, { action: "hold" }]);
  });

  it("pauses writing at the cap minus the check reserve, and tells the Editor-in-Chief", async () => {
    const t = await setup(27.5);
    const assigned = await assignDaily(
      pools.app,
      t.boss,
      router,
      { newsroomId: t.newsroomId, seriesId: t.seriesId },
      NOW,
    );
    if (assigned.kind !== "assigned") throw new Error("not assigned");
    expect(
      await runDesk(t.deps, { newsroomId: t.newsroomId, agentRunId: assigned.runId }),
    ).toBeNull();
    const { rows: run } = await pools.system.query("select outcome from agent_runs where id = $1", [
      assigned.runId,
    ]);
    expect(run[0]).toEqual({ outcome: "paused" });
    expect((await t.publications()).map((p) => p.status)).toEqual(["with-editor", "with-editor"]);
    const { rows: notices } = await pools.system.query(
      "select kind from notices where newsroom_id = $1 order by kind",
      [t.newsroomId],
    );
    expect(notices).toEqual([{ kind: "budget-cap" }, { kind: "budget-warning" }]);
  });

  it("stops a run at its format's token cap and holds it", async () => {
    const t = await setup();
    const assigned = await assignDaily(
      pools.app,
      t.boss,
      router,
      { newsroomId: t.newsroomId, seriesId: t.seriesId },
      NOW,
    );
    if (assigned.kind !== "assigned") throw new Error("not assigned");
    t.deps.makeModel = (_chain) => meteredChat(scripted(t.answers), "writer", { tokenCap: 200 });
    t.answers.push("{}", "{}", "{}");
    expect(await runDesk(t.deps, { newsroomId: t.newsroomId, agentRunId: assigned.runId })).toBe(
      "error",
    );
    const { rows } = await pools.system.query<{ name: string }>(
      "select distinct name from checks where newsroom_id = $1",
      [t.newsroomId],
    );
    expect(rows).toEqual([{ name: "token-cap" }]);
  });

  it("tells the Editor-in-Chief when there are no leads, and assigns nothing", async () => {
    const t = await setup();
    const late = new Date(NOW.getTime() + 3 * 24 * 3600_000);
    expect(
      await assignDaily(
        pools.app,
        t.boss,
        router,
        { newsroomId: t.newsroomId, seriesId: t.seriesId },
        late,
      ),
    ).toMatchObject({
      kind: "no-leads",
    });
    const { rows } = await pools.system.query("select kind from notices where newsroom_id = $1", [
      t.newsroomId,
    ]);
    expect(rows).toEqual([{ kind: "no-leads" }]);
  });
});
