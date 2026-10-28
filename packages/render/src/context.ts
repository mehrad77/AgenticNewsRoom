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
