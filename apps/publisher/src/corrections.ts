// Publishing an upheld challenge's corrections (D115). Only code publishes: the desk records each
// notice, and this job puts it on its piece (the page, its ninjs twin and JSON-LD read it) and
// marks the piece Corrected. The piece's text and its posts stay as they went out.
import type { PublishCorrectionJob } from "@anr/core";
import { auditedUpdate, type Pool, withNewsroom } from "@anr/db";
import { PUBLISHER } from "./publish.ts";

export async function publishCorrections(
  pool: Pool,
  job: PublishCorrectionJob,
  now: Date = new Date(),
): Promise<number> {
  return withNewsroom(pool, job.newsroomId, async (client) => {
    const { rows } = await client.query<{ id: string; publication: string; status: string }>(
      `select k.id, k.publication_id as publication, p.status
       from corrections k join publications p on p.id = k.publication_id
       where k.challenge_id = $1 and k.published_at is null
       order by k.id for update of k, p`,
      [job.challengeId],
    );
    for (const r of rows) {
      await auditedUpdate(client, PUBLISHER, "publish-correction", "corrections", r.id, {
        published_at: now,
      });
      if (r.status !== "corrected")
        await auditedUpdate(client, PUBLISHER, "correct", "publications", r.publication, {
          status: "corrected",
        });
    }
    return rows.length;
  });
}
