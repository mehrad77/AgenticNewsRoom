// A published image (D120): the publisher's copy, with its Photo Metadata and licence in XMP and
// its C2PA manifest, served at `/m/<media id>.<ext>`. An image no published piece has shown has
// no copy, and is not found.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Pool, withNewsroom } from "@anr/db";
import type { ReaderNewsroom } from "./reader.ts";
import { mediaRedirect } from "./storage.ts";

const IMAGE =
  /^\/m\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(jpg|png|webp)$/;

export function mediaRoute(path: string): string | null {
  return IMAGE.exec(path)?.[1] ?? null;
}

export async function publishedImage(
  pool: Pool,
  newsroom: Pick<ReaderNewsroom, "id">,
  mediaId: string,
): Promise<{ key: string; contentType: string } | null> {
  return withNewsroom(pool, newsroom.id, async (c) => {
    const { rows } = await c.query<{ key: string; content_type: string }>(
      "select published_file as key, content_type from media where id = $1 and published_file is not null",
      [mediaId],
    );
    const row = rows[0];
    return row ? { key: row.key, contentType: row.content_type } : null;
  });
}

/** A redirect into the media bucket, or the local store; a copy never changes once written. */
export async function imageResponse(image: {
  key: string;
  contentType: string;
}): Promise<Response> {
  const redirect = await mediaRedirect(image.key);
  if (redirect) return redirect;
  const dir = process.env.ANR_MEDIA_DIR ?? join(process.cwd(), "../../.data/media");
  return new Response(readFileSync(join(dir, image.key)), {
    headers: {
      "content-type": image.contentType,
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
