// A member's image (D119): ingestion fetches it, reads its Photo Metadata and stores a media row.
// When it cannot, the member finds a `media-failed` notice in the desk; nothing is retried, since
// a refusal (robots.txt, not an image) stays one and the member can add the image again. Each
// failure of the same URL brings its notice back, unread, with the latest reason.
import type { IngestMediaJob } from "@anr/core";
import { type Pool, withNewsroom } from "@anr/db";
import type { IngestionClient } from "../ingest.ts";

export type IngestMediaOutcome = { kind: "media"; id: string } | { kind: "noticed" };

export async function ingestMedia(
  pool: Pool,
  ingestion: Pick<IngestionClient, "addMedia">,
  job: IngestMediaJob,
): Promise<IngestMediaOutcome> {
  const outcome = await ingestion.addMedia(job);
  if (outcome.kind === "media") return { kind: "media", id: outcome.result.media_id };
  await withNewsroom(pool, job.newsroomId, (client) =>
    client.query(
      `insert into notices (newsroom_id, kind, key, detail)
       values (anr.current_newsroom_id(), 'media-failed', $1, $2)
       on conflict (newsroom_id, kind, key)
         do update set detail = excluded.detail, read_at = null, created_at = now()`,
      [job.url, JSON.stringify({ url: job.url, outcome: outcome.kind, reason: outcome.detail })],
    ),
  );
  return { kind: "noticed" };
}
