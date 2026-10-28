// A newsroom's podcast on its site (D110): the feed per series and language, built from the items
// the publisher stored as Posts of the podcast-rss channel, and the episode audio behind a counting
// redirect. A download is counted once per listener and day: the key is an HMAC of address and
// user agent under a secret derived for that day, so it is never stored in the clear and cannot
// link a listener across days; rows older than yesterday are deleted.
import { createHmac, randomBytes } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { type Language, pageUrl, type SiteAddress } from "@anr/core";
import { type Pool, withNewsroom } from "@anr/db";
import { createRenderer } from "@anr/render";
import type { ReaderNewsroom } from "./reader.ts";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const AUDIO = new RegExp(`^/a/(${UUID})\\.mp3$`);
const FEED = /^\/podcast\/([a-z0-9][a-z0-9-]*)\.xml$/;

export type PodcastRoute =
  | { kind: "audio"; publicationId: string }
  | { kind: "feed"; series: string }
  | null;

export function podcastRoute(path: string): PodcastRoute {
  const audio = AUDIO.exec(path);
  if (audio?.[1]) return { kind: "audio", publicationId: audio[1] };
  const feed = FEED.exec(path);
  if (feed?.[1]) return { kind: "feed", series: feed[1] };
  return null;
}

/** Crawlers are not listeners; podcast apps are. */
const NOT_A_LISTENER = /bot|crawl|spider|slurp|monitor/i;

/** The day's secret: derived from the platform key, or random per process without one. */
const fallback = randomBytes(32);
export function daySecret(day: string, platformKey = process.env.ANR_PLATFORM_KEY): Buffer {
  const base = platformKey ? Buffer.from(platformKey, "base64") : fallback;
  return createHmac("sha256", base).update(`downloads:${day}`).digest();
}

export const listenerKey = (secret: Buffer, address: string, userAgent: string) =>
  createHmac("sha256", secret).update(`${address}\n${userAgent}`).digest();

/** The newest audio of a published episode, or null. */
export async function episodeAudio(
  pool: Pool,
  newsroom: Pick<ReaderNewsroom, "id">,
  publicationId: string,
): Promise<string | null> {
  return withNewsroom(pool, newsroom.id, async (c) => {
    const { rows } = await c.query<{ media_key: string }>(
      `select e.media_key from episodes e join publications p on p.id = e.publication_id
       where p.id = $1 and p.status in ('published', 'corrected')
       order by e.created_at desc limit 1`,
      [publicationId],
    );
    return rows[0]?.media_key ?? null;
  });
}

/**
 * The listener's address: behind the site's proxy (Caddy), the last X-Forwarded-For entry, which
 * the proxy itself wrote; without the header, the connection's own address.
 */
export function listenerAddress(forwardedFor: string | null, connection: string): string {
  const last = forwardedFor?.split(",").at(-1)?.trim();
  return last || connection;
}

/** Counts one download per listener, episode and day in the newsroom's timezone. */
export async function countDownload(
  pool: Pool,
  newsroom: Pick<ReaderNewsroom, "id" | "timezone">,
  publicationId: string,
  address: string,
  userAgent: string | null,
  now: Date = new Date(),
): Promise<boolean> {
  if (!userAgent || NOT_A_LISTENER.test(userAgent)) return false;
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: newsroom.timezone }).format(now);
  const key = listenerKey(daySecret(day), address, userAgent);
  return withNewsroom(pool, newsroom.id, async (c) => {
    await c.query("delete from download_keys where day < $1::date - 1", [day]);
    const { rowCount } = await c.query(
      `insert into download_keys (newsroom_id, publication_id, day, key)
       values (anr.current_newsroom_id(), $1, $2, $3) on conflict do nothing`,
      [publicationId, day, key],
    );
    if (!rowCount) return false;
    await c.query(
      `insert into downloads (newsroom_id, publication_id, day, count)
       values (anr.current_newsroom_id(), $1, $2, 1)
       on conflict (publication_id, day) do update set count = downloads.count + 1`,
      [publicationId, day],
    );
    return true;
  });
}

/** `bytes=start-end` (one range) as inclusive offsets in a file of `size` bytes; null if unusable. */
export function byteRange(header: string | null, size: number): [number, number] | null {
  const match = /^bytes=([0-9]*)-([0-9]*)$/.exec(header?.trim() ?? "");
  if (!match || (!match[1] && !match[2])) return null;
  const [start, end] = match[1]
    ? [Number(match[1]), match[2] ? Math.min(Number(match[2]), size - 1) : size - 1]
    : [Math.max(0, size - Number(match[2])), size - 1];
  return start <= end && start < size ? [start, end] : null;
}

/**
 * Where a stored episode is fetched from: object storage's public URL, or the local store,
 * streamed and with byte ranges, as podcast apps ask for them.
 */
export function audioResponse(mediaKey: string, range: string | null = null): Response {
  const base = process.env.ANR_MEDIA_URL;
  if (base) return Response.redirect(`${base.replace(/\/$/, "")}/${mediaKey}`, 302);
  const dir = process.env.ANR_MEDIA_DIR ?? join(process.cwd(), "../../.data/media");
  const file = join(dir, mediaKey);
  const size = statSync(file).size;
  const headers = { "content-type": "audio/mpeg", "accept-ranges": "bytes" };
  const stream = (start: number, end: number) =>
    Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
  if (range === null || size === 0)
    return new Response(size === 0 ? null : stream(0, size - 1), {
      headers: { ...headers, "content-length": String(size) },
    });
  const span = byteRange(range, size);
  if (!span)
    return new Response(null, {
      status: 416,
      headers: { ...headers, "content-range": `bytes */${size}` },
    });
  const [start, end] = span;
  return new Response(stream(start, end), {
    status: 206,
    headers: {
      ...headers,
      "content-length": String(end - start + 1),
      "content-range": `bytes ${start}-${end}/${size}`,
    },
  });
}

let renderer: ReturnType<typeof createRenderer> | undefined;
/** One renderer for every feed request, as the site's pages keep one (page.ts). */
export const feedRenderer = () => (renderer ??= createRenderer());

const xml = (s: string) =>
  s.replace(
    /[<>&'"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] ?? c,
  );

/**
 * A series' feed in one language: the channel's own description with the AI label, and every
 * item the publisher stored for it, newest first. Null when the newsroom has no such feed.
 */
export async function podcastFeed(
  pool: Pool,
  newsroom: ReaderNewsroom,
  language: Language,
  seriesSlug: string,
  site: SiteAddress,
  aiLabel: string,
): Promise<string | null> {
  return withNewsroom(pool, newsroom.id, async (c) => {
    const { rows: series } = await c.query<{ name: Record<string, string> | null }>(
      `select s.config->'name' as name from series s join formats f on f.id = s.format_id
       where s.slug = $1 and f.slug = 'podcast-episode' and s.removed_at is null
         and s.config->'channels'->'podcast-rss' ? $2`,
      [seriesSlug, language],
    );
    if (!series[0]) return null;
    const { rows: items } = await c.query<{ body: string }>(
      `select po.body from posts po
       join channels ch on ch.id = po.channel_id and ch.kind = 'podcast-rss' and ch.language = $2
       join publications p on p.id = po.publication_id
       join series s on s.id = p.series_id and s.slug = $1
       where p.status in ('published', 'corrected') and po.status = 'sent'
       order by p.slot desc limit 100`,
      [seriesSlug, language],
    );
    const title = series[0].name?.[language] ?? seriesSlug;
    const author = newsroom.name[language] ?? newsroom.slug;
    const link = pageUrl(site, language, "/");
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0">',
      "<channel>",
      `<title>${xml(title)}</title>`,
      `<link>${xml(link)}</link>`,
      `<language>${language}</language>`,
      `<description>${xml(`${title}, ${author}. ${aiLabel}.`)}</description>`,
      `<itunes:author>${xml(author)}</itunes:author>`,
      "<itunes:explicit>false</itunes:explicit>",
      ...items.map((i) => i.body),
      "</channel>",
      "</rss>",
    ].join("\n");
  });
}
