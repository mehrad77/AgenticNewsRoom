// What a publication would send now: every channel's parts and the site page, from the publisher's
// own renderer, template context and label check (D98). The desk shows this before an approval.
import { type Language, pageUrl, publicationPath } from "@anr/core";
import type { Client } from "@anr/db";
import { channelKinds, type createRenderer, editedByPerson, templateContext } from "@anr/render";
import { DeskError } from "./errors.ts";

export interface PreviewSite {
  rootDomain: string;
  devPort?: number;
}

export async function previewPublication(
  client: Client,
  renderer: ReturnType<typeof createRenderer>,
  address: PreviewSite,
  id: string,
) {
  const { rows } = await client.query<{
    slot: Date;
    language: Language;
    series_slug: string;
    channels: Record<string, string[]>;
    format: string;
    subdomain: string;
    languages: Language[];
    timezone: string;
  }>(
    `select p.slot, p.language, s.slug as series_slug,
            coalesce(s.config->'channels', '{}') as channels, f.slug as format,
            n.subdomain, n.languages, n.timezone
     from publications p
     join series s on s.id = p.series_id
     join formats f on f.id = s.format_id
     join newsrooms n on n.id = p.newsroom_id
     where p.id = $1`,
    [id],
  );
  const p = rows[0];
  if (!p) throw new DeskError(404, "no such publication");
  const { rows: renditions } = await client.query<{ id: string; body: Record<string, unknown> }>(
    `select r.id, r.body from publication_renditions pr
     join renditions r on r.id = pr.rendition_id
     where pr.publication_id = $1 order by pr.position`,
    [id],
  );
  const first = renditions[0];
  if (!first) throw new DeskError(409, "the publication has no text yet");
  const site = { ...address, subdomain: p.subdomain, languages: p.languages };
  const edited = await editedByPerson(
    client,
    id,
    renditions.map((r) => r.id),
  );
  const context = await templateContext(client, {
    rendition: first.body,
    edited,
    site,
    language: p.language,
    seriesSlug: p.series_slug,
    slot: p.slot,
    timezone: p.timezone,
  });
  const label = await renderer.disclosureLabel(p.language, edited);
  const { rows: active } = await client.query<{ kind: string }>(
    "select distinct kind from channels where language = $1 and status = 'active'",
    [p.language],
  );
  const channels = [];
  for (const kind of channelKinds(p.channels, p.language)) {
    const configured = active.some((c) => c.kind === kind);
    try {
      const parts = await renderer.renderParts(p.format, kind, p.language, context);
      // The publisher holds a part without the label (invariant 8); the preview says so.
      const error = parts.every((x) => x.includes(label))
        ? undefined
        : "a part is missing the disclosure label";
      channels.push({ kind, configured, parts, ...(error && { error }) });
    } catch (e) {
      channels.push({ kind, configured, parts: [], error: (e as Error).message });
    }
  }
  const url = pageUrl(site, p.language, publicationPath(p.series_slug, p.slot, p.timezone));
  let page: { url: string; html: string; error?: string };
  try {
    page = { url, html: await renderer.render(p.format, "site", p.language, context) };
  } catch (e) {
    page = { url, html: "", error: (e as Error).message };
  }
  return { label, edited, site: page, channels };
}
