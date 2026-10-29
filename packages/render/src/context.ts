// What a publication's templates are rendered with. The publisher sends from it and the desk
// previews from it, so a preview is exactly what goes out.
import { type Language, pageUrl, publicationPath, type SiteAddress, siteOrigin } from "@anr/core";
import type { Client } from "@anr/db";

/** The lead ids a rendition's items cite, in order, once each. */
export function leadIds(body: unknown): string[] {
  const items = (body as { items?: { lead_id?: unknown }[] }).items ?? [];
  return [
    ...new Set(items.map((i) => i.lead_id).filter((id): id is string => typeof id === "string")),
  ];
}

/** The media ids a rendition's items show, once each (D119). */
export function mediaIds(body: unknown): string[] {
  const items = (body as { items?: { media_id?: unknown }[] }).items ?? [];
  return [
    ...new Set(items.map((i) => i.media_id).filter((id): id is string => typeof id === "string")),
  ];
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** An image as the site serves it: the publisher's copy with its metadata and manifest (D120). */
export const mediaPath = (mediaId: string, contentType: string) =>
  `/m/${mediaId}.${EXTENSIONS[contentType] ?? "bin"}`;

export interface MediaContext {
  url: string;
  alt: string;
  credit: string;
  licence: string;
  licence_url: string;
  /** As recorded from the source image, else null (D45). */
  digital_source_type: string | null;
  /** Its recorded source type says AI made it, in whole or part: the caption labels it. */
  ai_made: boolean;
}

/** IPTC digital source types of media made, in whole or part, by a model or algorithm. */
const AI_MADE =
  /\/(trainedAlgorithmicMedia|compositeWithTrainedAlgorithmicMedia|compositeSynthetic|algorithmicMedia)$/;

/** The licensed images a rendition shows, by id; an unlicensed one is left out (D16). */
export async function mediaContext(
  client: Client,
  body: unknown,
  origin: string,
): Promise<Record<string, MediaContext>> {
  const ids = mediaIds(body);
  if (ids.length === 0) return {};
  const { rows } = await client.query<{
    id: string;
    content_type: string;
    description: string | null;
    credit_line: string;
    licence: string;
    licence_url: string;
    digital_source_type: string | null;
  }>(
    `select id, content_type, description, credit_line, licence, licence_url, digital_source_type
     from media
     where id = any($1::uuid[]) and licence is not null`,
    [ids.filter((id) => UUID.test(id))],
  );
  return Object.fromEntries(
    rows.map((m) => [
      m.id,
      {
        url: `${origin}${mediaPath(m.id, m.content_type)}`,
        alt: m.description ?? "",
        credit: m.credit_line,
        licence: m.licence,
        licence_url: m.licence_url,
        digital_source_type: m.digital_source_type,
        ai_made: AI_MADE.test(m.digital_source_type ?? ""),
      },
    ]),
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a person changed the publication's text: the audit log says (AI disclosure). */
export async function editedByPerson(
  client: Client,
  publicationId: string,
  renditionIds: string[],
): Promise<boolean> {
  const { rows } = await client.query<{ edited: boolean }>(
    `select exists (
       select 1 from audit_log
       where actor_kind = 'person' and action = 'edit'
         and ((entity = 'renditions' and entity_id = any($2::uuid[]))
              or (entity = 'publications' and entity_id = $1))
     ) as edited`,
    [publicationId, renditionIds],
  );
  return rows[0]?.edited === true;
}

/** The channel kinds other than the site that a series sends to in `language`. */
export function channelKinds(channels: Record<string, string[]>, language: Language): string[] {
  return Object.entries(channels)
    .filter(([kind, languages]) => kind !== "site" && languages.includes(language))
    .map(([kind]) => kind);
}

export interface SitePathInput {
  publicationId: string;
  language: Language;
  seriesSlug: string;
  slot: Date;
  timezone: string;
}

/**
 * The publication's path on its language's site (D92): its series and local date, with a suffix
 * when another publication of that language already has the path (two slots on one day).
 */
export async function sitePath(client: Client, input: SitePathInput): Promise<string> {
  const path = publicationPath(input.seriesSlug, input.slot, input.timezone);
  const { rows } = await client.query(
    "select 1 from publications where language = $1 and path = $2 and id <> $3",
    [input.language, path, input.publicationId],
  );
  return rows.length > 0 ? `${path}-${input.publicationId.slice(0, 8)}` : path;
}

export interface ContextInput extends SitePathInput {
  rendition: Record<string, unknown>;
  edited: boolean;
  site: SiteAddress;
  /** For an episode: its voices' notes line, from `_partials/ai-voices-notes.liquid`. */
  voicesNote?: string;
}

/** An episode's audio as the site serves it: through the counting redirect (D110). */
export const audioPath = (publicationId: string) => `/a/${publicationId}.mp3`;

/** The chapters an episode's script has: its recap topics' and stories' titles. */
export function chapterTitles(rendition: unknown): string[] {
  const items = (rendition as { items?: unknown[] }).items ?? [];
  return items.flatMap((item) => {
    const i = item as { segment?: string; title?: string; topics?: { title?: string }[] };
    if (i.segment === "news-recap")
      return (i.topics ?? []).map((t) => t.title ?? "").filter(Boolean);
    if (i.segment === "story" && i.title) return [i.title];
    return [];
  });
}

/** Whether a rendition is an episode script. */
export const isEpisode = (rendition: unknown) =>
  ((rendition as { items?: { segment?: unknown }[] }).items ?? []).some((i) => i?.segment);

/** Template context shared by every channel of the publication, the site included. */
export async function templateContext(client: Client, input: ContextInput) {
  const { rows } = await client.query<{ id: string; uri: string; headline: string | null }>(
    "select id, uri, headline from leads where id = any($1::uuid[])",
    [leadIds(input.rendition)],
  );
  const path = await sitePath(client, input);
  const episode = isEpisode(input.rendition) ? await episodeContext(client, input) : {};
  return {
    ...episode,
    rendition: input.rendition,
    edited: input.edited,
    site_url: pageUrl(input.site, input.language, path),
    ai_policy_url: pageUrl(input.site, input.language, "/ai-policy"),
    leads: Object.fromEntries(rows.map((l) => [l.id, { url: l.uri, headline: l.headline }])),
    media: await mediaContext(client, input.rendition, siteOrigin(input.site)),
  };
}

/**
 * An episode's audio and notes: the redirect URL, the newest audio file's size and length (empty
 * until it is made), and notes listing its chapters and naming its voices as AI.
 */
async function episodeContext(client: Client, input: ContextInput) {
  const { rows } = await client.query<{ bytes: string; seconds: string }>(
    "select bytes, seconds from episodes where publication_id = $1 order by created_at desc limit 1",
    [input.publicationId],
  );
  const audio = rows[0];
  const chapters = chapterTitles(input.rendition);
  return {
    publication_id: input.publicationId,
    audio_url: `${siteOrigin(input.site)}${audioPath(input.publicationId)}`,
    audio_bytes: audio ? Number(audio.bytes) : 0,
    audio_seconds: audio ? Math.round(Number(audio.seconds)) : 0,
    published_at: input.slot.toUTCString(),
    show_notes: [chapters.join(" · "), input.voicesNote ?? ""].filter(Boolean).join("\n"),
  };
}
