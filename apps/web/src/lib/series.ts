// A series' own page and its block on a news home (D179): its published pieces in one language,
// newest first, each with a line about it from its rendition.
import type { Language } from "@anr/core";
import { type Pool, withNewsroom } from "@anr/db";
import type { Names } from "./reference-config.ts";

export interface SeriesIndex {
  series: string;
  name: Names;
  intro?: Names;
}

export interface SeriesPiece {
  id: string;
  title: string | null;
  path: string;
  publishedAt: Date;
  /** A line about the piece: an episode's summary, else its first paragraph. */
  line: string | null;
  imported: boolean;
}

/** The first thing a rendition says about itself: its summary, or its first item's text. */
export function lineOf(body: Record<string, unknown> | null): string | null {
  if (!body) return null;
  if (typeof body.summary === "string" && body.summary.trim()) return body.summary.trim();
  const first = (body.items as Record<string, unknown>[] | undefined)?.[0];
  const text = Array.isArray(first?.paragraphs) ? first.paragraphs[0] : first?.body;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

/** A series' published pieces in a language, newest first. */
export function seriesPieces(
  pool: Pool,
  newsroomId: string,
  series: string,
  language: Language,
  limit = 200,
): Promise<SeriesPiece[]> {
  return withNewsroom(pool, newsroomId, async (c) => {
    const { rows } = await c.query<{
      id: string;
      title: string | null;
      path: string;
      published_at: Date;
      origin: string;
      body: Record<string, unknown> | null;
    }>(
      `select p.id, p.title, p.path, p.published_at, p.origin, r.body
       from publications p
       join series s on s.id = p.series_id
       left join publication_renditions pr on pr.publication_id = p.id and pr.position = 1
       left join renditions r on r.id = pr.rendition_id
       where s.slug = $1 and p.language = $2 and p.status in ('published', 'corrected')
       order by p.published_at desc limit $3`,
      [series, language, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      path: r.path,
      publishedAt: r.published_at,
      line: lineOf(r.body),
      imported: r.origin === "imported",
    }));
  });
}

export interface Artwork {
  src: string;
  alt: string;
  credit: string;
}

/**
 * The newsroom's own artwork by role (D180), such as `series/<series>/show`, `/hero` or
 * `/host/<host>`: only what the publisher has published a copy of.
 */
export function artwork(
  pool: Pool,
  newsroomId: string,
  rolePrefix: string,
): Promise<Map<string, Artwork>> {
  return withNewsroom(pool, newsroomId, async (c) => {
    const { rows } = await c.query<{
      role: string;
      published_file: string;
      description: string | null;
      credit_line: string | null;
    }>(
      `select role, published_file, description, credit_line from media
       where role like $1 || '%' and published_file is not null`,
      [rolePrefix],
    );
    return new Map(
      rows.map((r) => [
        r.role.slice(rolePrefix.length),
        { src: `/${r.published_file}`, alt: r.description ?? "", credit: r.credit_line ?? "" },
      ]),
    );
  });
}

/** An episode's cover (D180), named on its rendition: its published copy, if there is one. */
export function coverOf(
  pool: Pool,
  newsroomId: string,
  body: Record<string, unknown>,
): Promise<Artwork | null> {
  const cover = body.cover as { media_id?: string; alt?: string } | undefined;
  if (!cover?.media_id) return Promise.resolve(null);
  return withNewsroom(pool, newsroomId, async (c) => {
    const { rows } = await c.query<{ published_file: string; credit_line: string | null }>(
      "select published_file, credit_line from media where id = $1 and published_file is not null",
      [cover.media_id],
    );
    const r = rows[0];
    return r
      ? { src: `/${r.published_file}`, alt: cover.alt ?? "", credit: r.credit_line ?? "" }
      : null;
  });
}
