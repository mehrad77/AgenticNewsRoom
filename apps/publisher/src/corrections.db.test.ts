// Publishing corrections on anr_test (D115): each notice goes live once and the piece is Corrected.
import { createTestNewsroom, testPools } from "@anr/db/testing";
import { afterAll, describe, expect, it } from "vitest";
import { publishCorrections } from "./corrections.ts";

const pools = testPools();
afterAll(() => pools.end());
const one = async (sql: string, params: unknown[]) =>
  ((await pools.system.query(sql, params)).rows[0] as { id: string }).id;

describe("publishing corrections (D115)", () => {
  it("publishes each notice once and marks the piece Corrected, audited as the publisher", async () => {
    const newsroomId = await createTestNewsroom(pools.system, "corr");
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
      `insert into publications (newsroom_id, series_id, assignment_id, slot, language, status)
       values ($1, $2, $3, '2030-01-01', 'en', 'published') returning id`,
      [newsroomId, series, assignment],
    );
    const challengeId = await one(
      `insert into challenges (newsroom_id, publication_id, reader_text, owner, acknowledge_by,
                               answer_by, token_hash, reader_key)
       values ($1, $2, 'The album came out in 2021, not 2019.', 'Editor', now(), now(), '\\x00', 'k')
       returning id`,
      [newsroomId, publication],
    );
    await pools.system.query(
      `insert into corrections (newsroom_id, publication_id, challenge_id, notice)
       values ($1, $2, $3, 'The album came out in 2021.')`,
      [newsroomId, publication, challengeId],
    );
    const job = { newsroomId, challengeId };
    expect(await publishCorrections(pools.app, job)).toBe(1);
    expect(await publishCorrections(pools.app, job)).toBe(0);
    const { rows } = await pools.system.query(
      `select p.status, k.published_at is not null as live,
              (select array_agg(action order by action) from audit_log
               where entity_id in (p.id, k.id) and actor_name = 'publisher') as actions
       from publications p join corrections k on k.publication_id = p.id where p.id = $1`,
      [publication],
    );
    expect(rows[0]).toEqual({
      status: "corrected",
      live: true,
      actions: ["correct", "publish-correction"],
    });
  });
});
