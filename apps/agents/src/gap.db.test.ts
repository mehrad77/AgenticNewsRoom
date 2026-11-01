// Once after a gap (D130), the agents worker's rows of the technical design's table on anr_test:
// the server is asleep from 18:00 to 21:00, and each job that came due meanwhile runs once at 21:00
// (pg-boss's `missed: "once"` sends it; schedules.test.ts pins the policies). Ingestion takes its
// next run and backups are the host scheduler's (infra/host/).
import { createTestNewsroom, testPools } from "@anr/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assignDaily } from "./assign.ts";
import { challengeDeadline } from "./challenges/deadline.ts";
import { sweepStuck } from "./gate/sweep.ts";
import { pickDeadline } from "./planner/deadline.ts";
import { ModelRouter } from "./router.ts";

const pools = testPools();
afterAll(() => pools.end());
const boss = { send: async () => "job" };
const router = new ModelRouter({
  catalog: [],
  roles: { desk: { default: ["m"] }, "fact-checker": [] },
} as never);
/** Asleep from 18:00; back at 21:00. */
const BACK = new Date("2031-03-10T21:00:00Z");

let newsroomId = "";
const one = async (sql: string, params: unknown[]) =>
  ((await pools.system.query(sql, params)).rows[0] as { id: string }).id;
const series = (slug: string, format: string, config: object) =>
  one(
    `insert into series (newsroom_id, slug, format_id, languages, config)
     select $1, $2, f.id, '{en}', $4 from formats f where f.slug = $3 returning id`,
    [newsroomId, slug, format, JSON.stringify(config)],
  );
const notices = async (kind: string) =>
  (
    await pools.system.query<{ key: string }>(
      "select key from notices where newsroom_id = $1 and kind = $2 order by key",
      [newsroomId, kind],
    )
  ).rows.map((r) => r.key);

beforeAll(async () => {
  newsroomId = await createTestNewsroom(pools.system, "gap");
});

describe("after a 3-hour gap (D130)", () => {
  it("daily assignment: a slot that passed unassigned gets one slot-missed notice", async () => {
    // Assignment at 19:00 and slot at 20:00, both while asleep.
    const id = await series("evening", "newsletter-issue", {
      cadence: { daily: "20:00" },
      assignment_at: "19:00",
      items: { news: "1-3" },
    });
    const job = { newsroomId, seriesId: id };
    expect(await assignDaily(pools.app, boss, router, job, BACK)).toMatchObject({
      kind: "slot-passed",
    });
    // A second firing tells no one twice.
    await assignDaily(pools.app, boss, router, job, BACK);
    expect(await notices("slot-missed")).toEqual(["evening:2031-03-10T20:00:00.000Z"]);
  });

  it("daily assignment: runs once if its slot has not passed", async () => {
    // Assignment at 19:30 while asleep, slot at 22:00 after it: assigned now, for 22:00.
    const id = await series("late", "newsletter-issue", {
      cadence: { daily: "22:00" },
      assignment_at: "19:30",
      items: { news: "1-3" },
    });
    const outcome = await assignDaily(pools.app, boss, router, { newsroomId, seriesId: id }, BACK);
    // No leads in this newsroom: the assignment ran for its slot and told the editor so.
    expect(outcome).toEqual({ kind: "no-leads", slot: "2031-03-10T22:00:00.000Z" });
    expect(await notices("slot-missed")).not.toContain("late:2031-03-10T22:00:00.000Z");
  });

  it("gate deadline sweep: runs once; a publication still being written is held", async () => {
    const id = await series("gate", "classic-article", {});
    const publication = async (slot: string) => {
      const assignment = await one(
        "insert into assignments (newsroom_id, series_id, slot) values ($1, $2, $3) returning id",
        [newsroomId, id, slot],
      );
      return one(
        `insert into publications (newsroom_id, series_id, assignment_id, slot, language, status)
         values ($1, $2, $3, $4, 'en', 'assigned') returning id`,
        [newsroomId, id, assignment, slot],
      );
    };
    const soon = await publication("2031-03-10T21:20:00Z");
    const later = await publication("2031-03-11T09:00:00Z");
    expect(await sweepStuck(pools.app, BACK, [newsroomId])).toBe(1);
    expect(await sweepStuck(pools.app, BACK, [newsroomId])).toBe(0);
    const { rows } = await pools.system.query<{ id: string; status: string }>(
      "select id, status from publications where id = any($1)",
      [[soon, later]],
    );
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
      [soon]: "with-editor",
      [later]: "assigned",
    });
  });

  it("pick-deadline: fires once; an unchosen pick is skipped with a pick-missed notice", async () => {
    const id = await series("weekly", "classic-article", {});
    const cycle = await one(
      `insert into editorial_cycles (newsroom_id, starts, ends, theme, status, decided_at)
       values ($1, '2031-03-01', '2031-04-01', 'Theme', 'approved', now()) returning id`,
      [newsroomId],
    );
    const pick = await one(
      `insert into picks (newsroom_id, cycle_id, series_id, week, candidates, deadline, slot)
       values ($1, $2, $3, '2031-03-10', '[]', '2031-03-10T19:00:00Z', '2031-03-11T07:00:00Z')
       returning id`,
      [newsroomId, cycle, id],
    );
    const job = { newsroomId, pickId: pick };
    expect(await pickDeadline(pools.app, boss, job, BACK)).toBe("skipped");
    expect(await pickDeadline(pools.app, boss, job, BACK)).toBe("decided");
    expect(await notices("pick-missed")).toEqual([pick]);
  });

  it("challenge-deadline: a due reminder whose deadline also passed is skipped; overdue is sent", async () => {
    const id = await series("story", "artist-story", {});
    const assignment = await one(
      "insert into assignments (newsroom_id, series_id, slot) values ($1, $2, '2031-03-01') returning id",
      [newsroomId, id],
    );
    const publication = await one(
      `insert into publications (newsroom_id, series_id, assignment_id, slot, language, status, title)
       values ($1, $2, $3, '2031-03-01', 'en', 'published', 'Piece') returning id`,
      [newsroomId, id, assignment],
    );
    // Its acknowledgement was due at 20:00, while asleep; the reminder before it too.
    const challengeId = await one(
      `insert into challenges (newsroom_id, publication_id, reader_text, owner, acknowledge_by,
                               answer_by, token_hash, reader_key)
       values ($1, $2, 'The album came out in 2021, not 2019.', 'Editor',
               '2031-03-10T20:00:00Z', '2031-03-11T20:00:00Z', '\\x00', 'k') returning id`,
      [newsroomId, publication],
    );
    const step = { newsroomId, challengeId, step: "acknowledge" as const };
    expect(await challengeDeadline(pools.app, boss, { ...step, at: "due" }, BACK)).toBe("stale");
    expect(await challengeDeadline(pools.app, boss, { ...step, at: "overdue" }, BACK)).toBe(
      "noticed",
    );
    expect(await notices("challenge-due")).toEqual([]);
    expect(await notices("challenge-overdue")).toEqual([`${challengeId}:acknowledge`]);
  });
});
