// Images the Reference shows (D119, D162): each listed entry's licensed image gets its published
// copy here, as a piece's images do when it publishes, so the site can serve it at /m/<id>. Code
// publishes; a paused newsroom publishes nothing (D144).
import { isPaused, type Pool, withNewsroom } from "@anr/db";
import { MEDIA_COLUMNS, type MediaDeps, type MediaRow, publishCopies } from "./media.ts";

export async function publishReferenceImages(
  pool: Pool,
  deps: MediaDeps | undefined,
): Promise<{ published: number; failed: number }> {
  const out = { published: 0, failed: 0 };
  if (!deps) return out;
  const { rows: newsrooms } = await pool.query<{ id: string }>(
    "select id from newsrooms where removed_at is null and reference <> '{}'::jsonb",
  );
  for (const { id } of newsrooms) {
    await withNewsroom(pool, id, async (c) => {
      if (await isPaused(c)) return;
      const { rows } = await c.query<MediaRow>(
        `select ${MEDIA_COLUMNS} from media
         where published_file is null and licence is not null
           and id::text in (select facts->'image'->>'media_id' from reference_entries
                            where listed and facts ? 'image')
         limit 50`,
      );
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
