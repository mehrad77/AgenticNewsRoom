// What a publication's templates are rendered with. The publisher sends from it and the desk
// previews from it, so a preview is exactly what goes out.
import { type Language, pageUrl, publicationPath, type SiteAddress } from "@anr/core";
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

export interface ContextInput {
  rendition: Record<string, unknown>;
  edited: boolean;
  site: SiteAddress;
  language: Language;
  seriesSlug: string;
  slot: Date;
  timezone: string;
}

/** Template context shared by every channel of the publication, the site included. */
export async function templateContext(client: Client, input: ContextInput) {
  const { rows } = await client.query<{ id: string; uri: string; headline: string | null }>(
    "select id, uri, headline from leads where id = any($1::uuid[])",
    [leadIds(input.rendition)],
  );
  const path = publicationPath(input.seriesSlug, input.slot, input.timezone);
  return {
    rendition: input.rendition,
    edited: input.edited,
    site_url: pageUrl(input.site, input.language, path),
    ai_policy_url: pageUrl(input.site, input.language, "/ai-policy"),
    leads: Object.fromEntries(rows.map((l) => [l.id, { url: l.uri, headline: l.headline }])),
  };
}
