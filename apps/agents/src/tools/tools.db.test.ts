import { createTestNewsroom, testPools } from "@anr/db/testing";
import { afterAll, describe, expect, it } from "vitest";
import type { SourceRequestOutcome } from "../ingest.ts";
import { agentTools, TOOL_NAMES, type ToolContext } from "./tools.ts";

const pools = testPools();
afterAll(() => pools.end());

async function lead(
  newsroomId: string,
  uri: string,
  headline: string,
  body: string,
  language: string,
  tier = 2,
) {
  const { rows } = await pools.system.query<{ id: string }>(
    `insert into leads (newsroom_id, uri, headline, body, language, content_hash, tier)
     values ($1, $2, $3, $4, $5, md5($4), $6) returning id`,
    [newsroomId, uri, headline, body, language, tier],
  );
  return rows[0]?.id ?? "";
}

async function setup(requests: SourceRequestOutcome[] = []) {
  const newsroomId = await createTestNewsroom(pools.system, "tools");
  const other = await createTestNewsroom(pools.system, "tools-other");
  const fa = await lead(
    newsroomId,
    "https://lab.example/fa",
    "مدل‌های زبانی تازه",
    "آزمایشگاه نمونه امروز مدل‌های زبانی تازه‌ای منتشر کرد که ۴۰ درصد سریع‌تر است.",
    "fa",
    1,
  );
  const en = await lead(
    newsroomId,
    "https://www.news.example/orbit",
    "Orbit released",
    "Example Lab released Orbit, a language model that is 40 percent faster.",
    "en",
  );
  const gone = await lead(
    newsroomId,
    "https://arxiv.example/withdrawn",
    "Orbit preprint",
    "A preprint about Orbit, a language model, since withdrawn by its authors.",
    "en",
  );
  await pools.system.query(
    "update leads set withdrawn_at = now(), withdrawn_reason = 'withdrawn on arXiv' where id = $1",
    [gone],
  );
  const hidden = await lead(
    other,
    "https://elsewhere.example/orbit",
    "Orbit",
    "Orbit language model news.",
    "en",
  );
  const ctx: ToolContext = {
    pool: pools.app,
    newsroomId,
    agentRunId: "00000000-0000-0000-0000-000000000000",
    language: "fa",
    ingestion: {
      requestSource: async () => requests.shift() ?? { kind: "failed", detail: "none left" },
    },
    readLeads: new Map(),
  };
  const submitted: unknown[] = [];
  const tools = agentTools(ctx, async (draft) => {
    submitted.push(draft);
    return "ok";
  });
  const call = async (name: string, args: object) => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return JSON.parse(String(await t.invoke(args)));
  };
  return { ctx, tools, call, submitted, ids: { fa, en, gone, hidden } };
}

describe("agent tools (D73)", () => {
  it("are exactly the four tools of invariant 2", async () => {
    const { tools } = await setup();
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
  });

  it("read a lead's frozen text in this newsroom only, and mark withdrawn ones", async () => {
    const { call, ctx, ids } = await setup();
    const read = await call("read_lead", { lead_id: ids.en });
    expect(read).toMatchObject({ headline: "Orbit released", publisher: "news.example", tier: 2 });
    expect(read.text).toContain("40 percent faster");
    expect(ctx.readLeads.has(ids.en)).toBe(true);
    expect(await call("read_lead", { lead_id: ids.hidden })).toEqual({ error: "no such lead" });
    expect(await call("read_lead", { lead_id: "not-a-uuid" })).toEqual({ error: "no such lead" });
    expect((await call("read_lead", { lead_id: ids.gone })).withdrawn).toBe("withdrawn on arXiv");
  });

  it("search by trigrams over normalised text, in both scripts, skipping withdrawn leads", async () => {
    const { call, ids } = await setup();
    // No zero-width non-joiner and an Arabic kaf/ye: normalisation still finds the lead.
    const fa = await call("search_leads", { query: "مدلهاي زباني" });
    expect(fa.map((h: { id: string }) => h.id)).toEqual([ids.fa]);
    const en = (await call("search_leads", { query: "Orbit language model" })).map(
      (h: { id: string }) => h.id,
    );
    expect(en).toContain(ids.en);
    expect(en).not.toContain(ids.gone);
    expect(en).not.toContain(ids.hidden);
  });

  it("request a source through ingestion and turn every failure into an answer", async () => {
    const { call } = await setup([
      { kind: "lead", result: { lead_id: "l1", uri: "u", headline: "H", tier: 3, created: true } },
      { kind: "refused", status: 429, detail: "cap" },
      { kind: "refused", status: 422, detail: "private address" },
      { kind: "failed", detail: "timeout" },
    ]);
    const url = "https://example.org/page";
    expect(await call("request_source", { url })).toEqual({
      lead_id: "l1",
      headline: "H",
      tier: 3,
      already_stored: false,
    });
    expect((await call("request_source", { url })).error).toMatch(/all the source requests/);
    expect((await call("request_source", { url })).error).toBe("refused: private address");
    expect((await call("request_source", { url })).error).toMatch(/could not fetch/);
  });

  it("submit hands the draft to the role's handler", async () => {
    const { tools, submitted } = await setup();
    await tools.find((t) => t.name === "submit")?.invoke({ draft: { rendition: {} } });
    expect(submitted).toEqual([{ rendition: {} }]);
  });
});
