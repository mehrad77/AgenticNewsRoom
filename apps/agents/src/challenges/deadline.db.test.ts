// A challenge's reminder and deadline jobs on anr_test (D114).
import { createTestNewsroom, testPools } from "@anr/db/testing";
import { afterAll, describe, expect, it } from "vitest";
import { challengeDeadline } from "./deadline.ts";

const pools = testPools();
afterAll(() => pools.end());
const sent: unknown[] = [];
const boss = {
  send: async (_q: string, data: object) => {
    sent.push(data);
    return "job";
  },
};
const one = async (sql: string, params: unknown[]) =>
  ((await pools.system.query(sql, params)).rows[0] as { id: string }).id;

async function setup() {
  const newsroomId = await createTestNewsroom(pools.system, "chd");
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
    `insert into publications (newsroom_id, series_id, assignment_id, slot, language, status, title)
     values ($1, $2, $3, '2030-01-01', 'en', 'published', 'Piece') returning id`,
    [newsroomId, series, assignment],
  );
  const challengeId = await one(
    `insert into challenges (newsroom_id, publication_id, reader_text, owner, acknowledge_by,
                             answer_by, token_hash, reader_key)
     values ($1, $2, 'The album came out in 2021, not 2019.', 'Editor',
             '2030-01-02T10:00:00Z', '2030-01-03T10:00:00Z', '\\x00', 'k') returning id`,
    [newsroomId, publication],
  );
  const notices = async () =>
    (
      await pools.system.query<{ kind: string; key: string }>(
        "select kind, key from notices where newsroom_id = $1 order by created_at, kind",
        [newsroomId],
      )
    ).rows.map((n) => [n.kind, n.key.split(":")[1]]);
  return { job: { newsroomId, challengeId }, notices };
}

describe("challenge deadlines (D114)", () => {
  it("reminds before the deadline, notices when it passed, once each", async () => {
    const t = await setup();
    const ack = { ...t.job, step: "acknowledge" as const };
    expect(
      await challengeDeadline(
        pools.app,
        boss as never,
        { ...ack, at: "due" },
        new Date("2030-01-02T03:00:00Z"),
      ),
    ).toBe("early");
    expect(
      await challengeDeadline(
        pools.app,
        boss as never,
        { ...ack, at: "due" },
        new Date("2030-01-02T04:00:00Z"),
      ),
    ).toBe("noticed");
    const late = new Date("2030-01-02T10:00:00Z");
    expect(await challengeDeadline(pools.app, boss as never, { ...ack, at: "overdue" }, late)).toBe(
      "noticed",
    );
    expect(await challengeDeadline(pools.app, boss as never, { ...ack, at: "overdue" }, late)).toBe(
      "noticed",
    );
    expect(await t.notices()).toEqual([
      ["challenge-due", "acknowledge"],
      ["challenge-overdue", "acknowledge"],
    ]);
  });

  it("does nothing once the step is done", async () => {
    const t = await setup();
    await pools.system.query(
      `update challenges set answered_at = now(), outcome = 'rejected', answer = 'No.',
              acknowledged_at = now(), acknowledged_by = $2
       where id = $1`,
      [
        t.job.challengeId,
        await one("insert into users (email) values ($1) returning id", [
          `chd-${t.job.challengeId}@example.test`,
        ]),
      ],
    );
    expect(
      await challengeDeadline(
        pools.app,
        boss as never,
        { ...t.job, step: "answer", at: "overdue" },
        new Date("2030-01-04T00:00:00Z"),
      ),
    ).toBe("done");
    expect(await t.notices()).toEqual([]);
  });
});
