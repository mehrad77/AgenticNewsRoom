// Images the Reference shows (D119, D162) and the newsroom's own artwork (D180): each gets its published
// copy here, as a piece's images do when it publishes, so the site can serve it at /m/<id>. Code
// publishes; a paused newsroom publishes nothing (D144).
import { isPaused, type Pool, withNewsroom } from "@anr/db";
import { MEDIA_COLUMNS, type MediaDeps, type MediaRow, publishCopies } from "./media.ts";

const BATCH = 50;
const FIRST_ID = "00000000-0000-0000-0000-000000000000";
/**
 * Where each newsroom's next sweep starts: batches walk the images by id and wrap at the end, so
 * images that keep failing never take every batch from the rest.
 */
const resumeAfter = new Map<string, string>();

export async function publishReferenceImages(
  pool: Pool,
  deps: MediaDeps | undefined,
): Promise<{ published: number; failed: number }> {
  const out = { published: 0, failed: 0 };
  if (!deps) return out;
  // Every newsroom: own artwork is published whether or not it has a Reference.
  const { rows: newsrooms } = await pool.query<{ id: string }>(
    "select id from newsrooms where removed_at is null",
  );
  for (const { id } of newsrooms) {
    await withNewsroom(pool, id, async (c) => {
      if (await isPaused(c)) return;
      // Only images publishCopies can publish: licensed and credited (D120).
      const { rows } = await c.query<MediaRow>(
        `select ${MEDIA_COLUMNS} from media
         where published_file is null and licence is not null
           and nullif(trim(credit_line), '') is not null
           and (licence_kind = 'own'
                or id::text in (select facts->'image'->>'media_id' from reference_entries
                                where listed and facts ? 'image'))
           and id > $1::uuid
         order by id limit ${BATCH}`,
        [resumeAfter.get(id) ?? FIRST_ID],
      );
      const last = rows[rows.length - 1];
      if (rows.length === BATCH && last) resumeAfter.set(id, last.id);
      else resumeAfter.delete(id);
      if (rows.length === 0) return;
      const failed = await publishCopies(c, deps, rows, false);
      const { rows: done } = await c.query<{ n: number }>(
        "select count(*)::int as n from media where id = any($1::uuid[]) and published_file is not null",
        [rows.map((r) => r.id)],
      );
      out.published += done[0]?.n ?? 0;
      if (failed) {
        out.failed += rows.length - (done[0]?.n ?? 0);
        console.error(`[publisher] reference image ${failed.id}: ${failed.error}`);
      }
    });
  }
  return out;
}
