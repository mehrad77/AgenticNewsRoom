// Each minute's sweep queues audio for approved episodes that have none for their current script
// (D109). The queue is stately with one key per publication, so a sweep never piles up jobs.
import { type PodcastAudioJob, QUEUES } from "@anr/core";
import { type Pool, withNewsroom } from "@anr/db";
import type { PgBoss } from "pg-boss";

export async function queueAudio(pool: Pool, boss: Pick<PgBoss, "send">): Promise<number> {
  const { rows: newsrooms } = await pool.query<{ id: string }>(
    "select id from newsrooms where removed_at is null",
  );
  let queued = 0;
  for (const { id: newsroomId } of newsrooms) {
    const due = await withNewsroom(pool, newsroomId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `select p.id from publications p
         join series s on s.id = p.series_id join formats f on f.id = s.format_id
         where p.status = 'scheduled' and f.slug = 'podcast-episode'
           and not exists (select from episodes e where e.publication_id = p.id
                           and e.created_at >= p.updated_at)`,
      );
      return rows;
    });
    for (const { id } of due) {
      const job: PodcastAudioJob = { newsroomId, publicationId: id };
      if (await boss.send(QUEUES.podcastAudio, job, { singletonKey: id })) queued += 1;
    }
  }
  return queued;
}
