// The gate end to end: a story written by the desk and the renderer (scripted models), the real
// verifier service (Python, spawned here against anr_test), scripted checkers, then policy.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestNewsroom, loadRootEnv, testDatabaseUrl, testPools } from "@anr/db/testing";
import { createRenderer } from "@anr/render";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assignDaily } from "../assign.ts";
import { type RoleDeps, runDesk } from "../desk/run.ts";
import { type ChatLike, meteredChat } from "../model.ts";
import { FACT_CHECKER_ROLE } from "../prompts/roles.ts";
import { checkPass, sourcePass } from "../recheck/run.ts";
import { runRenderer } from "../renderer/run.ts";
import { ModelRouter } from "../router.ts";
import { type GateDeps, runGate, verifierClient } from "./run.ts";
import { sweepStuck } from "./sweep.ts";

const pools = testPools();
const configDir = fileURLToPath(new URL("../../../../config", import.meta.url));
const verifierDir = fileURLToPath(new URL("../../../../services/verifier", import.meta.url));
const NOW = new Date("2026-10-27T13:00:00Z");
let service: ChildProcess | undefined;
let verifierUrl = "";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

beforeAll(async () => {
  loadRootEnv();
  const port = await freePort();
  verifierUrl = `http://127.0.0.1:${port}`;
  const appUrl = process.env.DATABASE_URL;
  if (!appUrl) throw new Error("DATABASE_URL is not set");
  service = spawn(
    "uv",
    [
      "run",
      "--frozen",
      "uvicorn",
      "anr_verifier.app:app",
      "--host",
      "127.0.0.1",
      "--port",
      `${port}`,
    ],
    {
      cwd: verifierDir,
      env: { ...process.env, DATABASE_URL: testDatabaseUrl(appUrl), ANR_CONFIG_DIR: configDir },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  const until = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${verifierUrl}/healthz`)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > until) throw new Error("the verifier did not start");
    await new Promise((r) => setTimeout(r, 200));
  }
}, 40_000);

afterAll(async () => {
  service?.kill();
  await pools.end();
});

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
    // The writer's family comes first: the router must drop it (invariant 4).
    "fact-checker": ["writer", "checker"],
    "item-matcher": ["checker"],
    summariser: ["writer"],
  },
  tts: "writer",
} as never);

const FACTS = [
  ["Orbit", "Example Lab released Orbit on Monday."],
  ["Comet", "Orbit is 40 percent faster than Comet."],
  ["Nova", "Nova Labs opened a research office in Berlin."],
  ["Atlas", "Atlas scored 91 on the MMLU benchmark."],
  ["Pulse", "Pulse costs 20 dollars a month."],
] as const;
const FA = [
  "آزمایشگاه Example Lab مدل Orbit را منتشر کرد.",
  "مدل Orbit از Comet ۴۰ درصد سریع‌تر است.",
  "شرکت Nova Labs دفتری پژوهشی در Berlin گشود.",
  "مدل Atlas در آزمون MMLU امتیاز ۹۱ گرفت.",
  "اشتراک Pulse ماهانه ۲۰ دلار است.",
];

function draft(language: "fa" | "en", story: boolean, leadId: string) {
  return JSON.stringify({
    ...(story && {
      story: {
        summary: "Five lab updates.",
        beat: "labs",
        claims: FACTS.map(([, text], i) => ({
          id: `c${i + 1}`,
          kind: "fact",
          text,
          lead_id: leadId,
          quoted_passage: text,
        })),
      },
    }),
    rendition: {
      language,
      title: language === "fa" ? "خبرنامه‌ی روزانه" : "Daily Newsletter",
      items: FACTS.map(([name, text], i) => ({
        kind: "news",
        headline: name,
        body: language === "fa" ? FA[i] : text,
        claim_ids: [`c${i + 1}`],
      })),
    },
  });
}

/** Answers the fact-checker and the item matcher, recording what each was sent. */
function checkers(fact: string, item: string) {
  const seen: BaseMessage[][] = [];
  const model: ChatLike = {
    async invoke(messages) {
      seen.push(messages);
      const isFact = String(messages[0]?.content) === FACT_CHECKER_ROLE;
      return new AIMessage(isFact ? fact : item);
    },
  };
  return { model, seen };
}

async function writtenStory() {
  const newsroomId = await createTestNewsroom(pools.system, "gate");
  const { rows } = await pools.system.query<{ slug: string }>(
    `update newsrooms set languages = '{fa,en}', timezone = 'Europe/Istanbul',
            policy = '{"budget": {"monthly_usd": 30, "check_reserve_usd": 3},
                       "sources": {"min_independent": 2, "tier1_alone": true},
                       "auto_publish": ["newsletter-issue"]}'
     where id = $1 returning slug`,
    [newsroomId],
  );
  const slug = rows[0]?.slug ?? "";
  const dir = mkdtempSync(join(tmpdir(), "anr-gate-"));
  mkdirSync(join(dir, "newsrooms", slug), { recursive: true });
  writeFileSync(
    join(dir, "newsrooms", slug, "style.md"),
    readFileSync(join(configDir, "newsrooms/ai/style.md")),
  );
  symlinkSync(join(configDir, "formats"), join(dir, "formats"));
  const one = async (sql: string, params: unknown[]) =>
    (await pools.system.query<{ id: string }>(sql, params)).rows[0]?.id ?? "";
  const labs = await one(
    "insert into beats (newsroom_id, slug, status, media_topics) values ($1, 'labs', 'open', '{medtop:20001298}') returning id",
    [newsroomId],
  );
  const seriesId = await one(
    `insert into series (newsroom_id, slug, format_id, languages, config)
     select $1, 'daily-newsletter', f.id, '{fa,en}',
            '{"cadence": {"daily": "21:00"}, "items": {"news": "5-8"}, "channels": {"site": ["fa", "en"], "telegram": ["fa"]}}'
     from formats f where f.slug = 'newsletter-issue' returning id`,
    [newsroomId],
  );
  const leadId = await one(
    `insert into leads (newsroom_id, uri, headline, body, language, content_hash, tier, summary, fetched_at)
     values ($1, 'https://lab.example/week', 'Lab week', $2, 'en', 'h', 1, 's', $3::timestamptz - interval '1 hour')
     returning id`,
    [newsroomId, FACTS.map(([, t]) => t).join(" "), NOW],
  );
  await pools.system.query(
    "insert into lead_beats (newsroom_id, lead_id, beat_id) values ($1, $2, $3)",
    [newsroomId, leadId, labs],
  );
  const answers: string[] = [];
  const writer: ChatLike = {
    async invoke() {
      const next = answers.shift();
      if (next === undefined) throw new Error("no more answers");
      return new AIMessage(next);
    },
  };
  const boss = { send: async () => "job" } as unknown as Pick<PgBoss, "send">;
  const roleDeps: RoleDeps = {
    pool: pools.app,
    boss,
    router,
    configDir: dir,
    makeModel: (_chain, tokenCap) => meteredChat(writer, "writer", { tokenCap }),
    ingestion: { requestSource: async () => ({ kind: "failed", detail: "offline" }) },
    log: () => {},
  };
  const assigned = await assignDaily(pools.app, boss, router, { newsroomId, seriesId }, NOW);
  if (assigned.kind !== "assigned") throw new Error(`not assigned: ${assigned.kind}`);
  answers.push("{}", "{}", draft("fa", true, leadId));
  expect(await runDesk(roleDeps, { newsroomId, agentRunId: assigned.runId })).toBe("submitted");
  const { rows: runs } = await pools.system.query<{ id: string; story_id: string }>(
    "select id, story_id from agent_runs where newsroom_id = $1 and role = 'renderer'",
    [newsroomId],
  );
  answers.push(draft("en", false, leadId));
  expect(await runRenderer(roleDeps, { newsroomId, agentRunId: runs[0]?.id ?? "" })).toBe(
    "submitted",
  );
  const storyId = runs[0]?.story_id ?? "";

  const gate = (model: ChatLike, url = verifierUrl): GateDeps => ({
    pool: pools.app,
    router,
    configDir: dir,
    verifier: verifierClient(url),
    renderer: createRenderer(),
    makeModel: (chain, tokenCap) => {
      // Every chain the gate asks for avoids the writer's family.
      expect(chain).not.toContain("writer");
      return meteredChat(model, "checker", { tokenCap });
    },
    log: () => {},
  });
  const publications = async () =>
    (
      await pools.system.query<{ language: string; status: string }>(
        "select language, status from publications where newsroom_id = $1 order by language",
        [newsroomId],
      )
    ).rows;
  const holds = async () =>
    (
      await pools.system.query<{ name: string; result: string }>(
        "select distinct name, result from checks where newsroom_id = $1 and kind = 'policy' order by name",
        [newsroomId],
      )
    ).rows;
  return { newsroomId, storyId, gate, publications, holds };
}

const SUPPORTED = '{"verdict": "supported", "reason": "the passage says so"}';
const MATCH = '{"verdict": "match", "beyond": ""}';

describe("the verifier gate (D79, D80)", () => {
  it("schedules a daily issue whose every check passed, in both languages", async () => {
    const t = await writtenStory();
    const { model, seen } = checkers(SUPPORTED, MATCH);
    await runGate(t.gate(model), { newsroomId: t.newsroomId, storyId: t.storyId });
    const { rows: failed } = await pools.system.query(
      "select kind, name, item, detail from checks where newsroom_id = $1 and result <> 'pass'",
      [t.newsroomId],
    );
    expect(failed).toEqual([]);
    expect(await t.publications()).toEqual([
      { language: "en", status: "scheduled" },
      { language: "fa", status: "scheduled" },
    ]);
    // Five claims checked once each, whatever the number of languages; ten items matched.
    const fact = seen.filter((m) => String(m[0]?.content) === FACT_CHECKER_ROLE);
    expect(fact).toHaveLength(5);
    // The fact-checker sees one claim and one passage, nothing of the draft.
    expect(fact[0]).toHaveLength(2);
    expect(String(fact[0]?.[1]?.content)).not.toContain("Daily Newsletter");
    expect(seen).toHaveLength(15);
    const { rows: runs } = await pools.system.query<{ role: string; families: string[] }>(
      "select role, families from agent_runs where newsroom_id = $1 order by role",
      [t.newsroomId],
    );
    expect(runs.map((r) => [r.role, r.families])).toEqual([
      ["desk", ["writer"]],
      ["fact-checker", ["checker"]],
      ["item-matcher", ["checker"]],
      ["renderer", ["writer"]],
    ]);
    // A second gate job finds nothing left to do.
    expect(await runGate(t.gate(model), { newsroomId: t.newsroomId, storyId: t.storyId })).toBe(
      "nothing to gate",
    );
  }, 30_000);

  it("holds both languages when the fact-checker finds a claim unsupported", async () => {
    const t = await writtenStory();
    const { model } = checkers('{"verdict": "unsupported", "reason": "no"}', MATCH);
    await runGate(t.gate(model), { newsroomId: t.newsroomId, storyId: t.storyId });
    expect((await t.publications()).map((p) => p.status)).toEqual(["with-editor", "with-editor"]);
    expect(await t.holds()).toEqual([{ name: "checks", result: "fail" }]);
  }, 30_000);

  it("holds with an error when the verifier cannot be reached, and asks no model", async () => {
    const t = await writtenStory();
    const { model, seen } = checkers(SUPPORTED, MATCH);
    await runGate(t.gate(model, "http://127.0.0.1:9"), {
      newsroomId: t.newsroomId,
      storyId: t.storyId,
    });
    expect(seen).toHaveLength(0);
    expect((await t.publications()).map((p) => p.status)).toEqual(["with-editor", "with-editor"]);
    expect(await t.holds()).toEqual([
      { name: "checks", result: "error" },
      { name: "checks-missing", result: "error" },
    ]);
  }, 30_000);

  it("holds publications still drafted shortly before their slot", async () => {
    const t = await writtenStory();
    const late = new Date(NOW.getTime() + 5 * 3600_000);
    expect(await sweepStuck(pools.app, late)).toBeGreaterThanOrEqual(2);
    expect((await t.publications()).map((p) => p.status)).toEqual(["with-editor", "with-editor"]);
    expect(await t.holds()).toEqual([{ name: "deadline", result: "timed-out" }]);
  }, 30_000);
});

describe("an imported story (D184)", () => {
  it("is checked item by item, records what passed and never changes a publication", async () => {
    const newsroomId = await createTestNewsroom(pools.system, "recheck");
    await pools.system.query(
      `update newsrooms set languages = '{fa,en}', timezone = 'Europe/Istanbul',
              policy = '{"budget": {"monthly_usd": 30, "check_reserve_usd": 3},
                         "sources": {"min_independent": 2, "tier1_alone": true}}'
       where id = $1`,
      [newsroomId],
    );
    const one = async (sql: string, params: unknown[]) =>
      (await pools.system.query<{ id: string }>(sql, params)).rows[0]?.id ?? "";
    const labs = await one(
      "insert into beats (newsroom_id, slug, status, media_topics) values ($1, 'labs', 'open', '{medtop:20001298}') returning id",
      [newsroomId],
    );
    const seriesId = await one(
      `insert into series (newsroom_id, slug, format_id, languages, config)
       select $1, 'daily-newsletter', f.id, '{fa,en}', '{"cadence": {"daily": "21:00"}}'
       from formats f where f.slug = 'newsletter-issue' returning id`,
      [newsroomId],
    );
    const source = "Example Lab released Orbit on Monday. Orbit is 40 percent faster than Comet.";
    const leadId = await one(
      `insert into leads (newsroom_id, uri, headline, body, language, content_hash, tier, summary, fetched_at)
       values ($1, 'https://lab.example/orbit', 'Orbit', $2, 'en', 'h2', 1, 's', now()) returning id`,
      [newsroomId, source],
    );
    await pools.system.query(
      "insert into lead_beats (newsroom_id, lead_id, beat_id) values ($1, $2, $3)",
      [newsroomId, leadId, labs],
    );
    // The import's rows, as the system role writes them.
    const slot = "2025-05-22T18:00:00Z";
    const assignmentId = await one(
      "insert into assignments (newsroom_id, series_id, slot) values ($1, $2, $3) returning id",
      [newsroomId, seriesId, slot],
    );
    const storyId = await one(
      "insert into stories (newsroom_id, assignment_id) values ($1, $2) returning id",
      [newsroomId, assignmentId],
    );
    const items = (fa: boolean) => [
      {
        kind: "news",
        headline: "Orbit",
        body: fa ? "آزمایشگاه Example Lab مدل Orbit را منتشر کرد." : "Example Lab released Orbit.",
        claim_ids: [],
        url: "https://lab.example/orbit",
        anchor: "orbit",
      },
      {
        kind: "news",
        headline: "Gone",
        body: fa ? "خبری که منبعش رفته." : "A story whose source is gone.",
        claim_ids: [],
        url: "https://gone.example/x",
        anchor: "gone",
      },
    ];
    for (const language of ["fa", "en"]) {
      const renditionId = await one(
        `insert into renditions (newsroom_id, story_id, format_id, language, body)
         select $1, $2, f.id, $3, $4 from formats f where f.slug = 'newsletter-issue' returning id`,
        [
          newsroomId,
          storyId,
          language,
          { language, title: "Orbit", items: items(language === "fa") },
        ],
      );
      const publicationId = await one(
        `insert into publications (newsroom_id, series_id, assignment_id, slot, language, status,
                                   published_at, path, title, origin)
         values ($1, $2, $3, $4, $5, 'published', $4, '/daily-newsletter/2025-05-22', 'Orbit', 'imported')
         returning id`,
        [newsroomId, seriesId, assignmentId, slot, language],
      );
      await pools.system.query(
        "insert into publication_renditions (newsroom_id, publication_id, position, rendition_id) values ($1, $2, 1, $3)",
        [newsroomId, publicationId, renditionId],
      );
    }

    const claims = (text: string) =>
      new AIMessage(
        JSON.stringify({ claims: [{ text, passage: "Example Lab released Orbit on Monday." }] }),
      );
    const answers = [
      claims("آزمایشگاه Example Lab مدل Orbit را منتشر کرد"),
      claims("Example Lab released Orbit"),
    ];
    const writer: ChatLike = {
      async invoke() {
        const next = answers.shift();
        if (!next) throw new Error("no more answers");
        return next;
      },
    };
    const { model } = checkers(SUPPORTED, '{"verdict": "match"}');
    const deps = {
      pool: pools.app,
      boss: { send: async () => "job" } as unknown as Pick<PgBoss, "send">,
      router,
      models: { models: {} } as never,
      ingestion: {
        requestSource: async (_n: string, _r: string, url: string) =>
          url.includes("orbit")
            ? ({
                kind: "lead",
                result: { lead_id: leadId, uri: url, headline: "Orbit", tier: 1, created: false },
              } as const)
            : ({ kind: "failed", detail: "404" } as const),
      },
      makeModel: () => meteredChat(writer, "writer"),
      gate: {
        pool: pools.app,
        router,
        configDir,
        verifier: verifierClient(verifierUrl),
        renderer: createRenderer(),
        makeModel: (chain: readonly string[], tokenCap: number) => {
          expect(chain).not.toContain("writer");
          return meteredChat(model, "checker", { tokenCap });
        },
        log: () => {},
      },
      log: () => {},
    };
    const options = { newsroomId, limit: 10 };
    expect(await sourcePass(deps, options)).toBe(1);
    // The dead source is tried again on later passes, three times in all, then left labelled.
    expect(await sourcePass(deps, options)).toBe(1);
    expect(await sourcePass(deps, options)).toBe(1);
    expect(await sourcePass(deps, options)).toBe(0);
    const { rows: tries } = await pools.system.query<{ item: number; n: number }>(
      `select (task->>'item')::int as item, count(*)::int as n from agent_runs
       where newsroom_id = $1 and task->>'key' = 'recheck' group by 1 order by 1`,
      [newsroomId],
    );
    expect(tries).toEqual([
      { item: 0, n: 1 },
      { item: 1, n: 3 },
    ]);
    expect(await checkPass(deps, options)).toBe(1);
    // Checked again only once new claims are written.
    expect(await checkPass(deps, options)).toBe(0);

    const { rows: pubs } = await pools.system.query<{ language: string; status: string }>(
      "select language, status from publications where newsroom_id = $1 order by language",
      [newsroomId],
    );
    expect(pubs).toEqual([
      { language: "en", status: "published" },
      { language: "fa", status: "published" },
    ]);
    const { rows: checked } = await pools.system.query<{ language: string; item: string }>(
      `select p.language, ci.item from checked_items ci join publications p on p.id = ci.publication_id
       where ci.newsroom_id = $1 order by p.language`,
      [newsroomId],
    );
    expect(checked).toEqual([
      { language: "en", item: "items.0" },
      { language: "fa", item: "items.0" },
    ]);
    const { rows: policy } = await pools.system.query(
      "select from checks where newsroom_id = $1 and kind = 'policy'",
      [newsroomId],
    );
    expect(policy).toHaveLength(0);
  }, 30_000);
});
