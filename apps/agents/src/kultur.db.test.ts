// The Kültür gate (milestone 6): the second newsroom runs from its configuration alone. A renamed
// copy of config/newsrooms/kultur is synced into anr_test by the generic sync, then a chosen
// weekly pick goes through the desk (tr), the renderer (en, fa), the real verifier and the gate,
// with a marked opinion item and a licensed image. Models are scripted; nothing names Kültür.
import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@anr/config";
import { syncNewsroomsOnly } from "@anr/config/testing";
import { loadRootEnv, testDatabaseUrl, testPools } from "@anr/db/testing";
import { createRenderer } from "@anr/render";
import { AIMessage } from "@langchain/core/messages";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assignPick } from "./assign.ts";
import { type RoleDeps, runDesk } from "./desk/run.ts";
import { runGate, verifierClient } from "./gate/run.ts";
import { type ChatLike, meteredChat } from "./model.ts";
import { FACT_CHECKER_ROLE } from "./prompts/roles.ts";
import { runRenderer } from "./renderer/run.ts";
import { ModelRouter } from "./router.ts";

const pools = testPools();
const configDir = fileURLToPath(new URL("../../../config", import.meta.url));
const verifierDir = fileURLToPath(new URL("../../../services/verifier", import.meta.url));
const suffix = crypto.randomUUID().slice(0, 8);
const slug = `kultur-${suffix}`;
/** A Monday in the first cycle; the pick's slot is that week's Thursday, 12:00 in Istanbul. */
const MONDAY = new Date("2026-11-02T08:00:00Z");
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
    "fact-checker": ["writer", "checker"],
    "item-matcher": ["checker"],
    summariser: ["writer"],
  },
  tts: "writer",
} as never);

const LEAD =
  "Ada Nova released the album Deniz in 2019 on Kalan Müzik. The album has nine songs. " +
  "Ada Nova played at Babylon. The critic Selin Kaya called Deniz the boldest rock record of its decade.";
/** Each claim, its passage in the lead, and how each language says it. */
const CLAIMS = [
  {
    kind: "fact",
    passage: "Ada Nova released the album Deniz in 2019 on Kalan Müzik.",
    tr: "Ada Nova, Deniz albümünü 2019 yılında Kalan Müzik etiketiyle yayımladı.",
    en: "Ada Nova released the album Deniz in 2019 on Kalan Müzik.",
    fa: "Ada Nova آلبوم Deniz را در سال ۲۰۱۹ با Kalan Müzik منتشر کرد.",
  },
  {
    kind: "fact",
    passage: "The album has nine songs.",
    tr: "Albümde dokuz şarkı var.",
    en: "The album has nine songs.",
    fa: "این آلبوم نُه ترانه دارد.",
  },
  {
    kind: "fact",
    passage: "Ada Nova played at Babylon.",
    tr: "Ada Nova, Babylon sahnesinde çaldı.",
    en: "Ada Nova played at Babylon.",
    fa: "Ada Nova در Babylon اجرا کرد.",
  },
  {
    kind: "opinion",
    passage: "The critic Selin Kaya called Deniz the boldest rock record of its decade.",
    tr: "Eleştirmen Selin Kaya, Deniz için on yılının en cesur rock plağı dedi.",
    en: "The critic Selin Kaya called Deniz the boldest rock record of its decade.",
    fa: "منتقد Selin Kaya آلبوم Deniz را جسورترین صفحه‌ی راک دهه‌اش خواند.",
  },
] as const;

/** A piece of about 1,200 words: each claim's sentence, many times, one item per claim. */
function draft(language: "tr" | "en" | "fa", leadId: string, mediaId: string, story: boolean) {
  return JSON.stringify({
    ...(story && {
      story: {
        summary: "Ada Nova and the album Deniz.",
        beat: "music",
        claims: CLAIMS.map((c, i) => ({
          id: `c${i + 1}`,
          kind: c.kind,
          text: c.tr,
          lead_id: leadId,
          quoted_passage: c.passage,
        })),
      },
    }),
    rendition: {
      language,
      title: { tr: "Ada Nova", en: "Ada Nova", fa: "Ada Nova" }[language],
      items: CLAIMS.map((c, i) => ({
        paragraphs: Array.from({ length: 36 }, () => c[language]),
        ...(c.kind === "opinion" && { opinion: true }),
        ...(i === 0 && { media_id: mediaId }),
        claim_ids: [`c${i + 1}`],
      })),
    },
  });
}

async function setup() {
  // The repo's Kültür configuration under a test slug, upserted by config sync's own code.
  const config = loadConfig(configDir);
  const kultur = config.newsrooms.find((n) => n.slug === "kultur");
  if (!kultur) throw new Error("kultur newsroom missing");
  kultur.slug = slug;
  Object.assign(kultur.newsroom as object, { slug, subdomain: slug });
  config.newsrooms = [kultur];
  await syncNewsroomsOnly(pools.system, config);
  // The newsroom's folder (style guide) under its test slug, with the shared formats.
  const dir = mkdtempSync(join(tmpdir(), "anr-kultur-"));
  mkdirSync(join(dir, "newsrooms"), { recursive: true });
  cpSync(join(configDir, "newsrooms", "kultur"), join(dir, "newsrooms", slug), { recursive: true });
  symlinkSync(join(configDir, "formats"), join(dir, "formats"));

  const sys = pools.system;
  const one = async (sql: string, params: unknown[]) =>
    ((await sys.query(sql, params)).rows[0] as { id: string }).id;
  const newsroomId = await one("select id from newsrooms where slug = $1", [slug]);
  const seriesId = await one(
    "select id from series where newsroom_id = $1 and slug = 'artist-story'",
    [newsroomId],
  );
  const leadId = await one(
    `insert into leads (newsroom_id, uri, headline, body, language, content_hash, tier, summary, fetched_at)
     values ($1, 'https://kalan.example/ada-nova', 'Ada Nova: Deniz', $2, 'en', 'h', 1, 's', $3)
     returning id`,
    [newsroomId, LEAD, MONDAY],
  );
  await sys.query(
    `insert into lead_beats (newsroom_id, lead_id, beat_id)
     select $1, $2, id from beats where newsroom_id = $1 and slug = 'music'`,
    [newsroomId, leadId],
  );
  const userId = await one("insert into users (email) values ($1) returning id", [
    `${slug}@example.test`,
  ]);
  const mediaId = await one(
    `insert into media (newsroom_id, file, source_url, file_url, content_type, description,
                        credit_line, licence, licence_kind, licence_url, licence_recorded_by,
                        licence_recorded_at, lead_id, added_by)
     values ($1, 'raw/00/x', 'https://kalan.example/press', 'https://kalan.example/ada.jpg',
             'image/jpeg', 'Ada Nova on stage', 'Photo: Kalan Müzik', 'Press use with credit',
             'press-kit', 'https://kalan.example/press', $3, now(), $2, $3) returning id`,
    [newsroomId, leadId, userId],
  );
  const cycleId = await one(
    `insert into editorial_cycles (newsroom_id, starts, ends, theme, status, decided_at)
     values ($1, '2026-11-01', '2026-12-01', 'Debut albums', 'approved', now()) returning id`,
    [newsroomId],
  );
  const candidate = (title: string) => ({
    title,
    angle: "The album and what came of it.",
    why: "It fits the month.",
    lead_ids: [leadId],
  });
  const pickId = await one(
    `insert into picks (newsroom_id, cycle_id, series_id, week, candidates, deadline, slot, chosen, picked_at)
     values ($1, $2, $3, '2026-11-02', $4, '2026-11-03T21:00:00Z', '2026-11-05T09:00:00Z', 0, now())
     returning id`,
    [
      newsroomId,
      cycleId,
      seriesId,
      JSON.stringify(["Ada Nova", "Another", "A third"].map(candidate)),
    ],
  );
  return { newsroomId, seriesId, leadId, mediaId, pickId, dir };
}

describe("Kültür from configuration alone (milestone 6 gate)", () => {
  it("writes, renders and checks a weekly artist story in tr, en and fa", async () => {
    const t = await setup();
    const sent: string[] = [];
    const jobs = {
      send: async (queue: string) => {
        sent.push(queue);
        return "job";
      },
    } as unknown as Pick<PgBoss, "send">;
    const answers: string[] = [];
    const writer: ChatLike = {
      async invoke() {
        const next = answers.shift();
        if (next === undefined) throw new Error("no more answers");
        return new AIMessage(next);
      },
    };
    const deps: RoleDeps = {
      pool: pools.app,
      boss: jobs,
      router,
      configDir: t.dir,
      makeModel: (_chain, tokenCap) => meteredChat(writer, "writer", { tokenCap }),
      ingestion: { requestSource: async () => ({ kind: "failed", detail: "offline" }) },
      log: () => {},
    };
    const assigned = await assignPick(
      pools.app,
      jobs,
      router,
      { newsroomId: t.newsroomId, seriesId: t.seriesId, pickId: t.pickId },
      MONDAY,
    );
    expect(assigned).toMatchObject({ kind: "assigned", leads: 1 });
    if (assigned.kind !== "assigned") return;

    answers.push("{}", "{}", draft("tr", t.leadId, t.mediaId, true));
    expect(await runDesk(deps, { newsroomId: t.newsroomId, agentRunId: assigned.runId })).toBe(
      "submitted",
    );
    const { rows: renderers } = await pools.system.query<{ id: string; language: "en" | "fa" }>(
      "select id, language from agent_runs where newsroom_id = $1 and role = 'renderer' order by language",
      [t.newsroomId],
    );
    expect(renderers.map((r) => r.language)).toEqual(["en", "fa"]);
    for (const r of renderers) {
      answers.push(draft(r.language, t.leadId, t.mediaId, false));
      expect(await runRenderer(deps, { newsroomId: t.newsroomId, agentRunId: r.id })).toBe(
        "submitted",
      );
    }
    const { rows: story } = await pools.system.query<{ id: string }>(
      "select id from stories where newsroom_id = $1",
      [t.newsroomId],
    );

    // Checkers in another family: every fact supported, every item within its claims.
    const facts: string[] = [];
    const checker: ChatLike = {
      async invoke(messages) {
        const fact = String(messages[0]?.content) === FACT_CHECKER_ROLE;
        if (fact) facts.push(String(messages[1]?.content));
        return new AIMessage(
          fact
            ? '{"verdict": "supported", "reason": "the passage says so"}'
            : '{"verdict": "match", "beyond": ""}',
        );
      },
    };
    await runGate(
      {
        pool: pools.app,
        router,
        configDir: t.dir,
        verifier: verifierClient(verifierUrl),
        renderer: createRenderer(),
        makeModel: (chain, tokenCap) => {
          expect(chain).not.toContain("writer");
          return meteredChat(checker, "checker", { tokenCap });
        },
        log: () => {},
      },
      { newsroomId: t.newsroomId, storyId: story[0]?.id ?? "" },
    );
    const { rows: failed } = await pools.system.query(
      `select kind, name, result, detail from checks
       where newsroom_id = $1 and result <> 'pass' and kind <> 'policy'`,
      [t.newsroomId],
    );
    expect(failed).toEqual([]);
    const { rows: passed } = await pools.system.query<{ name: string }>(
      "select distinct name from checks where newsroom_id = $1 and result = 'pass' order by name",
      [t.newsroomId],
    );
    expect(passed.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "disclosure",
        "format:length",
        "format:opinion-has-no-facts",
        "media-credit",
        "media-licence",
      ]),
    );
    // Opinion is labelled, not fact-checked: three facts, each once whatever the languages.
    expect(facts).toHaveLength(3);
    // Every piece is themed work: it waits for an editor, in every language.
    const { rows: pubs } = await pools.system.query(
      "select language, status from publications where newsroom_id = $1 order by language",
      [t.newsroomId],
    );
    expect(pubs).toEqual([
      { language: "en", status: "with-editor" },
      { language: "fa", status: "with-editor" },
      { language: "tr", status: "with-editor" },
    ]);
  }, 60_000);
});
