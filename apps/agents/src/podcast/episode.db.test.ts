// A weekly episode on anr_test (D107): the week's published stories → the episode story with
// copied claims → one script per language, written part by part by a scripted model.
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { QUEUES } from "@anr/core";
import { withNewsroom } from "@anr/db";
import { createTestNewsroom, testPools } from "@anr/db/testing";
import { AIMessage } from "@langchain/core/messages";
import type { PgBoss } from "pg-boss";
import { afterAll, describe, expect, it } from "vitest";
import type { RoleDeps } from "../desk/run.ts";
import { writerFamilies } from "../gate/run.ts";
import { type ChatLike, meteredChat } from "../model.ts";
import { ModelRouter } from "../router.ts";
import { assignEpisode } from "./episode.ts";
import { episodePrompt, runEpisode } from "./run.ts";

const pools = testPools();
afterAll(() => pools.end());
const configDir = fileURLToPath(new URL("../../../../config", import.meta.url));
/** Friday 6 November 2026, 08:00 in Istanbul: the episode's assignment time. */
const FRIDAY = new Date("2026-11-06T05:00:00Z");

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
  const newsroomId = await createTestNewsroom(pools.system, "ep");
  const { rows: n } = await pools.system.query<{ slug: string }>(
    `update newsrooms set languages = '{fa,en}', timezone = 'Europe/Istanbul',
            policy = '{"budget": {"monthly_usd": 30, "check_reserve_usd": 3}}'
     where id = $1 returning slug`,
    [newsroomId],
  );
  const slug = n[0]?.slug ?? "";
  const dir = mkdtempSync(join(tmpdir(), "anr-ep-"));
  mkdirSync(join(dir, "newsrooms", slug), { recursive: true });
  writeFileSync(
    join(dir, "newsrooms", slug, "style.md"),
    readFileSync(join(configDir, "newsrooms/ai/style.md")),
  );
  symlinkSync(join(configDir, "formats"), join(dir, "formats"));
  const one = async (sql: string, params: unknown[]) =>
    (await pools.system.query<{ id: string }>(sql, params)).rows[0]?.id ?? "";

  const series = async (s: string, format: string, config: object) =>
    one(
      `insert into series (newsroom_id, slug, format_id, languages, config)
       select $1, $2, f.id, '{fa,en}', $3 from formats f where f.slug = $4 returning id`,
      [newsroomId, s, JSON.stringify(config), format],
    );
  const daily = await series("daily-newsletter", "newsletter-issue", {
    cadence: { daily: "21:00" },
  });
  const classic = await series("weekly-classic", "classic-article", {
    cadence: { weekly: "wed 10:00" },
  });
  const podcastId = await series("weekly-podcast", "podcast-episode", {
    name: { en: "Weekly Podcast" },
    cadence: { weekly: "fri 18:00" },
    assignment_at: "fri 08:00",
    segments: [
      { kind: "news-recap", minutes: 1, from: "week.daily-newsletter" },
      { kind: "story", minutes: 1, from: "week.weekly-classic" },
    ],
    hosts: { fa: { niloofar: "Sulafat", farzad: "Algenib" }, en: { maya: "Kore", leo: "Puck" } },
    narrator: { fa: "Alnilam", en: "Enceladus" },
  });
  const lead = await one(
    `insert into leads (newsroom_id, uri, headline, body, language, content_hash, tier)
     values ($1, 'https://arxiv.example/1706', 'Attention', 'Vaswani and colleagues proposed the Transformer.', 'en', 'h', 1)
     returning id`,
    [newsroomId],
  );

  /** A published story of `seriesId` at `slot`, with two claims and one rendition per language. */
  const published = async (seriesId: string, slot: string, status = "published") => {
    const assignment = await one(
      "insert into assignments (newsroom_id, series_id, slot) values ($1, $2, $3) returning id",
      [newsroomId, seriesId, slot],
    );
    const story = await one(
      "insert into stories (newsroom_id, assignment_id) values ($1, $2) returning id",
      [newsroomId, assignment],
    );
    for (const ref of ["c1", "c2"]) {
      await pools.system.query(
        `insert into claims (newsroom_id, story_id, ref, kind, text, lead_id, quoted_passage)
         values ($1, $2, $3, 'fact', $4, $5, 'Vaswani and colleagues proposed the Transformer')`,
        [newsroomId, story, ref, `Claim ${ref} of ${slot}`, lead],
      );
    }
    for (const language of ["fa", "en"]) {
      const rendition = await one(
        `insert into renditions (newsroom_id, story_id, format_id, language, body)
         select $1, $2, f.id, $3, $4 from formats f where f.slug = 'newsletter-issue' returning id`,
        [
          newsroomId,
          story,
          language,
          JSON.stringify({
            language,
            title: "T",
            items: [{ kind: "news", headline: "H", body: "B", claim_ids: ["c2"] }],
          }),
        ],
      );
      const pub = await one(
        `insert into publications (newsroom_id, series_id, assignment_id, slot, language, status)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [newsroomId, seriesId, assignment, slot, language, status],
      );
      await pools.system.query(
        "insert into publication_renditions (newsroom_id, publication_id, position, rendition_id) values ($1, $2, 1, $3)",
        [newsroomId, pub, rendition],
      );
    }
    return story;
  };
  const stories = {
    newsletter: await published(daily, "2026-11-03T18:00:00Z"),
    held: await published(daily, "2026-11-04T18:00:00Z", "with-editor"),
    lastWeek: await published(daily, "2026-10-29T18:00:00Z"),
    classic: await published(classic, "2026-11-04T07:00:00Z"),
  };

  const sent: { queue: string; data: Record<string, string> }[] = [];
  const boss = {
    send: async (queue: string, data: object) => {
      sent.push({ queue, data: data as Record<string, string> });
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
  return { newsroomId, podcastId, stories, boss, sent, answers, deps, q };
}

const ARC = ["cold-open", "context", "turning-point", "stakes", "resolution", "takeaway"];
const enScript = () => [
  JSON.stringify({
    topics: [
      {
        title: "Orbit",
        claim_ids: ["c2"],
        lines: [
          { host: "Maya", text: "Orbit came out." },
          { host: "leo", text: "It did." },
        ],
      },
    ],
  }),
  JSON.stringify({
    title: "Attention",
    protagonists: [{ name: "Ashish Vaswani", role: "first author", claim_ids: ["c3"] }],
  }),
  ...ARC.map((beat) =>
    JSON.stringify({
      beat,
      claim_ids: ["c3"],
      lines: [
        { speaker: "narrator", text: "Vaswani wrote it." },
        ...(beat === "cold-open" ? [{ cue: "sting" }] : []),
      ],
    }),
  ),
];

describe("weekly episodes (D107)", () => {
  it("fits the script prompt in 5 KB for every podcast language", () => {
    for (const [newsroom, languages] of [
      ["ai", ["fa", "en"]],
      ["kultur", ["tr", "en", "fa"]],
    ] as const) {
      for (const language of languages)
        expect(episodePrompt(configDir, newsroom, language).bytes).toBeLessThanOrEqual(5 * 1024);
    }
  });

  it("builds the episode story from the week's published stories, then writes each language", async () => {
    const t = await setup();
    const assigned = await assignEpisode(
      pools.app,
      t.boss,
      router,
      { newsroomId: t.newsroomId, seriesId: t.podcastId },
      FRIDAY,
    );
    expect(assigned).toMatchObject({ kind: "assigned", leads: 1 });
    // The slot is that Friday at 18:00; a second firing finds it.
    expect(
      await assignEpisode(
        pools.app,
        t.boss,
        router,
        { newsroomId: t.newsroomId, seriesId: t.podcastId },
        FRIDAY,
      ),
    ).toEqual({ kind: "exists", slot: "2026-11-06T15:00:00.000Z" });

    // Claims of this week's published newsletter and classic paper only, copied in segment order.
    const claims = await t.q<{ ref: string; story: string }>(
      `select c.ref, o.story_id as story from claims c join claims o on o.id = c.copied_from
       where c.newsroom_id = $1 order by c.ref`,
    );
    expect(claims).toEqual([
      { ref: "c1", story: t.stories.newsletter },
      { ref: "c2", story: t.stories.newsletter },
      { ref: "c3", story: t.stories.classic },
      { ref: "c4", story: t.stories.classic },
    ]);
    // Invariant 4: the families that wrote the copied claims are writers of the episode too.
    const [episodeStory] = await t.q<{ id: string }>(
      `select s.id from stories s join assignments a on a.id = s.assignment_id
       where s.newsroom_id = $1 and a.series_id = $2`,
      [t.podcastId],
    );
    const run = (storyId: string, role: string, family: string) =>
      pools.system.query(
        `insert into agent_runs (newsroom_id, role, provider, model, prompt_version, input_hash,
                                 story_id, families, outcome)
         values ($1, $2, 'p', 'm', 'v', 'h', $3, $4, 'submitted')`,
        [t.newsroomId, role, storyId, [family]],
      );
    await run(t.stories.classic, "desk", "pro-family");
    await run(t.stories.held, "desk", "not-copied");
    await run(episodeStory?.id ?? "", "renderer", "flash-family");
    const families = await withNewsroom(pools.app, t.newsroomId, (c) =>
      writerFamilies(c, episodeStory?.id ?? ""),
    );
    expect(families.sort()).toEqual(["flash-family", "pro-family"]);

    const runs = t.sent.filter((s) => s.queue === QUEUES.agentRun);
    expect(runs).toHaveLength(2);
    const byLanguage = await t.q<{ id: string; language: string }>(
      "select id, language from agent_runs where newsroom_id = $1 and role = 'renderer' order by language",
    );

    // Persian: the model names a host the series does not have, twice: that language is held.
    t.answers.push(
      ...Array(2).fill(
        JSON.stringify({
          topics: [{ title: "x", claim_ids: ["c2"], lines: [{ host: "maya", text: "x" }] }],
        }),
      ),
    );
    const fa = byLanguage.find((r) => r.language === "fa")?.id ?? "";
    expect(await runEpisode(t.deps, { newsroomId: t.newsroomId, agentRunId: fa })).toBe("invalid");

    // English: every part valid; the recap's newsletter refs are the episode's (c2, not the source's).
    t.answers.push(...enScript());
    t.sent.length = 0;
    const en = byLanguage.find((r) => r.language === "en")?.id ?? "";
    expect(await runEpisode(t.deps, { newsroomId: t.newsroomId, agentRunId: en })).toBe(
      "submitted",
    );
    expect(t.answers).toEqual([]);
    const [script] = await t.q<{ body: { title: string; items: { segment: string }[] } }>(
      `select r.body from renditions r join stories s on s.id = r.story_id
       join assignments a on a.id = s.assignment_id
       where r.newsroom_id = $1 and a.series_id = $2 and r.language = 'en'`,
      [t.podcastId],
    );
    expect(script?.body.title).toBe("Weekly Podcast · 2026-11-06");
    expect(script?.body.items.map((i) => i.segment)).toEqual(["news-recap", "story"]);
    expect(JSON.stringify(script?.body)).toContain('"host":"maya"');
    expect(
      await t.q(
        "select language, status from publications where newsroom_id = $1 and series_id = $2 order by language",
        [t.podcastId],
      ),
    ).toEqual([
      { language: "en", status: "drafted" },
      { language: "fa", status: "with-editor" },
    ]);
    // Both languages are done, so the gate runs on the episode story.
    expect(t.sent.map((s) => s.queue)).toEqual([QUEUES.gate]);
  });
});
