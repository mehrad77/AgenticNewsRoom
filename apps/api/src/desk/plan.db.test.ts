// The Editor-in-Chief's planning decisions on anr_test (D104, D105): approve an edited theme,
// choose a candidate before its deadline, and nothing for an editor or after the deadline.
import { randomBytes } from "node:crypto";
import { platformKey } from "@anr/db";
import { createTestNewsroom, testPools } from "@anr/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";

const pools = testPools();
afterAll(() => pools.end());
const sent: { queue: string; data: unknown }[] = [];
const boss = {
  send: async (queue: string, data: object) => {
    sent.push({ queue, data });
    return "job";
  },
};
let signedIn: string | null = null;
const app = createApp({
  pool: pools.app,
  boss: boss as never,
  platform: platformKey(randomBytes(32).toString("base64")),
  verify: async () => signedIn,
  site: { rootDomain: "example.test" },
});

const one = async (sql: string, params: unknown[]) =>
  ((await pools.system.query(sql, params)).rows[0] as { id: string }).id;
const chief = `chief-${randomBytes(4).toString("hex")}@example.test`;
const editor = `editor-${randomBytes(4).toString("hex")}@example.test`;
let newsroomId = "";
let slug = "";
let seriesId = "";
let leadId = "";
let cycleStart = "";

beforeAll(async () => {
  newsroomId = await createTestNewsroom(pools.system, "plan");
  slug = (
    await pools.system.query<{ slug: string }>("select slug from newsrooms where id = $1", [
      newsroomId,
    ])
  ).rows[0]?.slug as string;
  for (const [email, role] of [
    [chief, "editor-in-chief"],
    [editor, "editor"],
  ] as const) {
    const userId = await one("insert into users (email) values ($1) returning id", [email]);
    await pools.system.query(
      "insert into memberships (newsroom_id, user_id, role) values ($1, $2, $3)",
      [newsroomId, userId, role],
    );
  }
  seriesId = await one(
    `insert into series (newsroom_id, slug, format_id, languages, config)
     select $1, 'weekly-classic', f.id, '{en}', '{"cadence": {"weekly": "wed 10:00"}}'
     from formats f where f.slug = 'classic-article' returning id`,
    [newsroomId],
  );
  leadId = await one(
    `insert into leads (newsroom_id, uri, headline, body, language, content_hash, tier)
     values ($1, 'https://arxiv.example/1706.03762', 'Attention Is All You Need', 'text', 'en', 'h', 1)
     returning id`,
    [newsroomId],
  );
  // A cycle in the future, so the plan lists it whatever today is.
  cycleStart = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
});

const as = (email: string | null) => {
  signedIn = email;
};
const post = (path: string, body: unknown) =>
  app.request(`/desk/newsrooms/${slug}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function proposals(): Promise<string[]> {
  const calendar = JSON.stringify([
    { week: "2030-01-07", focus: "Transformers" },
    { week: "2030-01-14", focus: "Scaling" },
  ]);
  const ids: string[] = [];
  for (const theme of ["Open weights", "Small models"]) {
    ids.push(
      await one(
        `insert into editorial_cycles (newsroom_id, starts, ends, theme, angle, calendar, rationale, lead_ids)
         values ($1, $2::date, $2::date + 30, $3, 'An angle.', $4, 'Why now.', $5) returning id`,
        [newsroomId, cycleStart, theme, calendar, [leadId]],
      ),
    );
  }
  return ids;
}

describe("planning at the desk (D105)", () => {
  it("lists proposals with their leads, and lets only the Editor-in-Chief approve", async () => {
    const [open, small] = await proposals();
    as(editor);
    const listed = (await (await app.request(`/desk/newsrooms/${slug}/plan`)).json()) as {
      themes: { id: string; theme: string; leads: { headline: string }[] }[];
    };
    expect(listed.themes.map((t) => t.theme)).toEqual(["Open weights", "Small models"]);
    expect(listed.themes[0]?.leads).toEqual([
      {
        id: leadId,
        url: "https://arxiv.example/1706.03762",
        headline: "Attention Is All You Need",
      },
    ]);
    const edit = {
      theme: "Open weights, checked",
      angle: "Who builds open models, and who can check them.",
      calendar: [
        { week: "2030-01-07", focus: "Transformers" },
        { week: "2030-01-14", focus: "Evaluation" },
      ],
    };
    expect((await post(`/cycles/${open}/approve`, edit)).status).toBe(403);

    as(chief);
    const wrongWeeks = { ...edit, calendar: edit.calendar.slice(1) };
    expect((await post(`/cycles/${open}/approve`, wrongWeeks)).status).toBe(400);
    expect((await post(`/cycles/${open}/approve`, edit)).status).toBe(200);
    const rows = (
      await pools.system.query<{ id: string; theme: string; status: string; calendar: unknown }>(
        "select id, theme, status, calendar from editorial_cycles where newsroom_id = $1 order by created_at",
        [newsroomId],
      )
    ).rows;
    expect(rows).toEqual([
      { id: open, theme: edit.theme, status: "approved", calendar: edit.calendar },
      expect.objectContaining({ id: small, status: "declined" }),
    ]);
    // The edit is audited, before and after.
    const { rows: audit } = await pools.system.query<{ action: string; before: { theme: string } }>(
      "select action, before from audit_log where newsroom_id = $1 and entity = 'editorial_cycles' order by at",
      [newsroomId],
    );
    expect(audit.map((a) => a.action)).toEqual(["approve", "decline"]);
    expect(audit[0]?.before.theme).toBe("Open weights");
    expect((await post(`/cycles/${small}/approve`, edit)).status).toBe(409);
  });

  async function pick(deadline: Date) {
    const cycle = await one(
      `select id from editorial_cycles where newsroom_id = $1 and status = 'approved'`,
      [newsroomId],
    );
    const candidates = [0, 1, 2].map((i) => ({
      title: `Paper ${i}`,
      angle: "An angle.",
      why: "It fits.",
      lead_ids: [leadId],
    }));
    return one(
      `insert into picks (newsroom_id, cycle_id, series_id, week, candidates, deadline, slot)
       values ($1, $2, $3, $4, $5, $6, $6::timestamptz + interval '10 hours') returning id`,
      [
        newsroomId,
        cycle,
        seriesId,
        deadline.toISOString().slice(0, 10),
        JSON.stringify(candidates),
        deadline,
      ],
    );
  }

  it("chooses a candidate before the deadline and queues its assignment", async () => {
    const id = await pick(new Date(Date.now() + 86_400_000));
    as(editor);
    expect((await post(`/picks/${id}/choose`, { candidate: 1 })).status).toBe(403);
    as(chief);
    expect((await post(`/picks/${id}/choose`, { candidate: 3 })).status).toBe(400);
    sent.length = 0;
    expect((await post(`/picks/${id}/choose`, { candidate: 1 })).status).toBe(200);
    expect(sent).toEqual([{ queue: "assign", data: { newsroomId, seriesId, pickId: id } }]);
    const listed = (await (await app.request(`/desk/newsrooms/${slug}/plan`)).json()) as {
      picks: { id: string; chosen: number; candidates: { title: string }[] }[];
    };
    const shown = listed.picks.find((p) => p.id === id);
    expect(shown?.chosen).toBe(1);
    expect(shown?.candidates[1]?.title).toBe("Paper 1");
    expect((await post(`/picks/${id}/choose`, { candidate: 0 })).status).toBe(409);
  });

  it("refuses a choice once the deadline has passed", async () => {
    const id = await pick(new Date(Date.now() - 60_000));
    as(chief);
    const late = await post(`/picks/${id}/choose`, { candidate: 0 });
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({
      error: "the pick's deadline has passed; its slot is skipped",
    });
  });
});
