// A reader's challenge on the site (D114): the form's fields, the call to the API, and the
// reader's status page, which opens only with the token from its link.
import { createHash } from "node:crypto";
import { createTestNewsroom, testPools } from "@anr/db/testing";
import { afterAll, describe, expect, it } from "vitest";
import { challengeForm, challengeStatus, sendChallenge } from "./challenge.ts";
import { loadPage } from "./page.ts";

const pools = testPools();
afterAll(() => pools.end());
const one = async (sql: string, params: unknown[]) =>
  ((await pools.system.query(sql, params)).rows[0] as { id: string }).id;

describe("a reader's challenge", () => {
  it("reads the form, and drops a bot's", () => {
    const form = new FormData();
    form.set("text", "  The album came out in 2021, not 2019.  ");
    form.set("source_url", "");
    expect(challengeForm(form)).toEqual({ text: "The album came out in 2021, not 2019." });
    form.set("website", "spam.example");
    expect(challengeForm(form)).toBeNull();
  });

  it("passes the reader's address and agent to the API, and reads its refusal", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (status: number, body: unknown) =>
      (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(body), { status });
      }) as typeof fetch;
    const reader = { address: "203.0.113.7", userAgent: "Reader" };
    const ok = await sendChallenge(
      "http://api",
      "kultur",
      "p-1",
      { text: "x" },
      reader,
      fake(201, { id: "c", token: "t" }),
    );
    expect(ok).toEqual({ ok: true, id: "c", token: "t" });
    expect(calls[0]?.url).toBe("http://api/reader/newsrooms/kultur/publications/p-1/challenges");
    expect(
      (calls[0]?.init.headers as Record<string, string> | undefined)?.["cf-connecting-ip"],
    ).toBe("203.0.113.7");
    const busy = await sendChallenge(
      "http://api",
      "kultur",
      "p-1",
      { text: "x" },
      reader,
      fake(429, { error: "too many" }),
    );
    expect(busy).toEqual({ ok: false, status: 429, error: "too many" });
  });

  it("shows the reader's status page only with the token from their link", async () => {
    const newsroomId = await createTestNewsroom(pools.system, "chweb");
    const { rows } = await pools.system.query<{ subdomain: string }>(
      "select subdomain from newsrooms where id = $1",
      [newsroomId],
    );
    const series = await one(
      `insert into series (newsroom_id, slug, format_id, languages, config)
       select $1, 's', f.id, '{en}', '{}' from formats f where f.slug = 'artist-story' returning id`,
      [newsroomId],
    );
    const assignment = await one(
      "insert into assignments (newsroom_id, series_id, slot) values ($1, $2, '2030-01-01') returning id",
      [newsroomId, series],
    );
    const publication = await one(
      `insert into publications (newsroom_id, series_id, assignment_id, slot, language, status, title, path)
       values ($1, $2, $3, '2030-01-01', 'en', 'published', 'Piece', '/s/2030-01-01') returning id`,
      [newsroomId, series, assignment],
    );
    const token = "reader-token";
    const id = await one(
      `insert into challenges (newsroom_id, publication_id, reader_text, owner, acknowledge_by,
                               answer_by, token_hash, reader_key)
       values ($1, $2, 'The album came out in 2021, not 2019.', 'Editor', now() + interval '1 day',
               now() + interval '2 days', $3, 'k') returning id`,
      [newsroomId, publication, createHash("sha256").update(token).digest()],
    );
    const status = await challengeStatus(pools.app, newsroomId, id, token);
    expect(status).toMatchObject({
      readerText: "The album came out in 2021, not 2019.",
      outcome: null,
    });
    expect(await challengeStatus(pools.app, newsroomId, id, "wrong")).toBeNull();

    const page = (k: string) =>
      loadPage(
        { pool: pools.app, rootDomain: "example.test" },
        {
          subdomain: rows[0]?.subdomain as string,
          language: "en",
          path: `/challenge/${id}`,
          query: new URLSearchParams({ k }),
          userAgent: null,
        },
      );
    expect((await page(token)).kind).toBe("challenge");
    expect((await page("wrong")).kind).toBe("not-found");
  });
});
