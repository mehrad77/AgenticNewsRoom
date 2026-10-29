// Readers' challenges and corrections on anr_test (D114–D116): a reader's challenge with its four
// deadline jobs and rate limit, acknowledgement and answers at the desk, and an upheld challenge
// correcting every language of the story and the episode that copied its claim.
import { randomBytes } from "node:crypto";
import { platformKey } from "@anr/db";
import { createTestNewsroom, testPools } from "@anr/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { PER_READER_PER_DAY, tokenHash } from "./challenges.ts";

const pools = testPools();
afterAll(() => pools.end());
const sent: { queue: string; data: unknown; options: Record<string, unknown> }[] = [];
const boss = {
  send: async (queue: string, data: object, options: Record<string, unknown>) => {
    sent.push({ queue, data, options });
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
const editor = `editor-${randomBytes(4).toString("hex")}@example.test`;
let newsroomId = "";
let slug = "";
/** The story's publications by language, and the episode's English one. */
const pubs: Record<string, string> = {};
let episode = "";
let scheduled = "";

/** A published publication of `story` in `language`. */
async function published(seriesId: string, storyId: string, language: string, day: string) {
  const assignment = await one(
    "insert into assignments (newsroom_id, series_id, slot) values ($1, $2, $3) returning id",
    [newsroomId, seriesId, `${day}T10:00:00Z`],
  ).catch(async () =>
    one("select id from assignments where newsroom_id = $1 and series_id = $2 and slot = $3", [
      newsroomId,
      seriesId,
      `${day}T10:00:00Z`,
    ]),
  );
  const rendition = await one(
    `insert into renditions (newsroom_id, story_id, format_id, language, body)
     select $1, $2, f.id, $3, '{"items": []}' from formats f where f.slug = 'artist-story'
     returning id`,
    [newsroomId, storyId, language],
  );
  const id = await one(
    `insert into publications (newsroom_id, series_id, assignment_id, slot, language, status,
                               published_at, path, title)
     values ($1, $2, $3, $4, $5, 'published', $4, $6, 'Piece') returning id`,
    [newsroomId, seriesId, assignment, `${day}T10:00:00Z`, language, `/s/${day}`],
  );
  await pools.system.query(
    `insert into publication_renditions (newsroom_id, publication_id, position, rendition_id)
     values ($1, $2, 1, $3)`,
    [newsroomId, id, rendition],
  );
  return id;
}

beforeAll(async () => {
  newsroomId = await createTestNewsroom(pools.system, "challenge");
  slug = (
    await pools.system.query<{ slug: string }>("select slug from newsrooms where id = $1", [
      newsroomId,
    ])
  ).rows[0]?.slug as string;
  const userId = await one("insert into users (email) values ($1) returning id", [editor]);
  await pools.system.query(
    "insert into memberships (newsroom_id, user_id, role) values ($1, $2, 'editor')",
    [newsroomId, userId],
  );
  const series = await one(
    `insert into series (newsroom_id, slug, format_id, languages, config)
     select $1, 'artist-story', f.id, '{tr,en}', '{}' from formats f where f.slug = 'artist-story'
     returning id`,
    [newsroomId],
  );
  const story = async (day: string) => {
    const assignment = await one(
      "insert into assignments (newsroom_id, series_id, slot) values ($1, $2, $3) returning id",
      [newsroomId, series, `${day}T10:00:00Z`],
    );
    return one("insert into stories (newsroom_id, assignment_id) values ($1, $2) returning id", [
      newsroomId,
      assignment,
    ]);
  };
  const lead = await one(
    `insert into leads (newsroom_id, uri, headline, body, language, content_hash, tier)
     values ($1, 'https://fan.example/album', 'Album', 'The album came out in 2019.', 'en', 'h', 3)
     returning id`,
    [newsroomId],
  );
  const original = await story("2030-01-03");
  const claim = await one(
    `insert into claims (newsroom_id, story_id, ref, kind, text, lead_id, quoted_passage)
     values ($1, $2, 'c1', 'fact', 'The album came out in 2019.', $3, 'The album came out in 2019.')
     returning id`,
    [newsroomId, original, lead],
  );
  for (const language of ["tr", "en"])
    pubs[language] = await published(series, original, language, "2030-01-03");
  // The week's episode copied the claim (D107).
  const copy = await story("2030-01-04");
  await pools.system.query(
    `insert into claims (newsroom_id, story_id, ref, kind, text, lead_id, quoted_passage, copied_from)
     values ($1, $2, 'c1', 'fact', 'The album came out in 2019.', $3, 'The album came out in 2019.', $4)`,
    [newsroomId, copy, lead, claim],
  );
  episode = await published(series, copy, "en", "2030-01-04");
  // Its Turkish episode is approved and waiting for its slot.
  scheduled = await published(series, copy, "tr", "2030-01-04");
  await pools.system.query(
    "update publications set status = 'scheduled', published_at = null where id = $1",
    [scheduled],
  );
});

const as = (email: string | null) => {
  signedIn = email;
};
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const challenge = (publication: string, address = "203.0.113.7") =>
  post(
    `/reader/newsrooms/${slug}/publications/${publication}/challenges`,
    { text: "The album came out in 2021, not 2019.", source_url: "https://label.example/album" },
    { "x-forwarded-for": `10.0.0.1, ${address}`, "user-agent": "Reader" },
  );

describe("readers' challenges (D114)", () => {
  it("stores a challenge with its owner and deadlines, and queues four deadline jobs", async () => {
    sent.length = 0;
    const res = await challenge(pubs.tr as string);
    expect(res.status).toBe(201);
    const receipt = (await res.json()) as { id: string; token: string; acknowledge_by: string };
    const [row] = (
      await pools.system.query(
        "select owner, token_hash, reader_text, extract(epoch from answer_by - acknowledge_by)::int as gap from challenges where id = $1",
        [receipt.id],
      )
    ).rows;
    expect(row.owner).toBe("Editor");
    expect(Buffer.compare(row.token_hash, tokenHash(receipt.token))).toBe(0);
    expect(row.gap).toBe(24 * 3600);
    expect(sent.map((s) => [s.queue, (s.data as { step: string; at: string }).at])).toEqual([
      ["challenge-deadline", "due"],
      ["challenge-deadline", "overdue"],
      ["challenge-deadline", "due"],
      ["challenge-deadline", "overdue"],
    ]);
    expect(sent[1]?.options.startAfter).toEqual(new Date(receipt.acknowledge_by));
  });

  it("refuses short text, unpublished pieces and too many from one reader", async () => {
    const short = await post(`/reader/newsrooms/${slug}/publications/${pubs.en}/challenges`, {
      text: "Wrong.",
    });
    expect(short.status).toBe(400);
    expect((await challenge("00000000-0000-0000-0000-000000000000")).status).toBe(404);
    const address = "198.51.100.9";
    for (let i = 0; i < PER_READER_PER_DAY; i++)
      expect((await challenge(pubs.en as string, address)).status).toBe(201);
    expect((await challenge(pubs.en as string, address)).status).toBe(429);
  });
});

describe("answering at the desk (D115, D116)", () => {
  it("acknowledges, then upholds: a correction per affected piece and a check on the claim", async () => {
    const receipt = (await (await challenge(pubs.tr as string, "192.0.2.1")).json()) as {
      id: string;
    };
    const base = `/desk/newsrooms/${slug}/challenges/${receipt.id}`;
    as(null);
    expect((await post(`${base}/acknowledge`, {})).status).toBe(401);
    as(editor);
    const ack = await post(`${base}/acknowledge`, { note: "We are checking the label's site." });
    expect(ack.status).toBe(200);
    expect((await post(`${base}/acknowledge`, {})).status).toBe(409);

    const detail = (await (await app.request(base)).json()) as {
      claims: { ref: string; languages: string[] }[];
      affected: { id: string; language: string }[];
    };
    expect(detail.claims.map((c) => [c.ref, c.languages])).toEqual([["c1", ["en", "tr"]]]);
    expect(detail.affected.map((p) => p.id).sort()).toEqual(
      [pubs.tr, pubs.en, episode].sort() as string[],
    );

    const uphold = {
      answer: "You are right; corrected.",
      claim: "c1",
      lesson: "Release years should come from the label, not a fan site.",
      notices: { tr: "Albüm 2021'de çıktı." },
    };
    const missing = await post(`${base}/uphold`, uphold);
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toContain("en");
    sent.length = 0;
    const done = await post(`${base}/uphold`, {
      ...uphold,
      // A notice may be long (up to 2,000 characters).
      notices: { ...uphold.notices, en: `The album came out in 2021. ${"More. ".repeat(100)}` },
    });
    expect(done.status).toBe(200);
    const after = (await done.json()) as { outcome: string; corrections: { language: string }[] };
    expect(after.outcome).toBe("upheld");
    expect(after.corrections.map((c) => c.language).sort()).toEqual(["en", "en", "tr"]);
    expect(sent.map((s) => s.queue)).toEqual(["publish-correction"]);
    // The scheduled episode holding a copy of the claim is pulled back for an editor.
    const { rows: held } = await pools.system.query(
      `select p.status, k.name from publications p join checks k on k.publication_id = p.id
       where p.id = $1`,
      [scheduled],
    );
    expect(held).toEqual([{ status: "with-editor", name: "corrected-claim" }]);
    const { rows: checks } = await pools.system.query(
      `select k.kind, k.result, k.detail->>'lesson' as lesson, c.copied_from
       from checks k join claims c on c.id = k.claim_id
       join corrections r on r.check_id = k.id where r.challenge_id = $1 limit 1`,
      [receipt.id],
    );
    // On the original claim, so the gate fails it and every copy from now on.
    expect(checks[0]).toEqual({
      kind: "correction",
      result: "fail",
      lesson: uphold.lesson,
      copied_from: null,
    });
    expect((await post(`${base}/reject`, { answer: "No." })).status).toBe(409);
    const filed = await post(`${base}/issue`, { url: "https://github.com/x/y/issues/1" });
    expect(filed.status).toBe(200);
  });

  it("rejects with an answer, acknowledging it too", async () => {
    const receipt = (await (await challenge(pubs.en as string, "192.0.2.2")).json()) as {
      id: string;
    };
    as(editor);
    const res = await post(`/desk/newsrooms/${slug}/challenges/${receipt.id}/reject`, {
      answer: "The label's own page says 2019.",
    });
    const body = (await res.json()) as { outcome: string; acknowledged_at: string | null };
    expect([body.outcome, body.acknowledged_at !== null]).toEqual(["rejected", true]);
    const list = (await (await app.request(`/desk/newsrooms/${slug}/challenges`)).json()) as {
      outcome: string | null;
    }[];
    // Open ones first.
    expect(list[0]?.outcome).toBeNull();
  });
});
