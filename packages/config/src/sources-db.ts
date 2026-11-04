// A newsroom's sources as Postgres holds them (D192): read back into the shape of sources.yaml, so
// the same validation, schedules and export apply whether a source came from the file or the API.
import type { SourcesSchema } from "@anr/schemas";
import { stringify } from "yaml";

export type Source = SourcesSchema[number];

/** The columns `sourceFromRow` reads. */
export const SOURCE_COLUMNS = `id, slug, kind, url, publisher, tier,
  extract(epoch from fetch_every)::int as every_seconds, use, terms_checked::text as terms_checked,
  terms_note, fetch_pages, vouches`;

export interface SourceRow {
  id: string;
  slug: string;
  kind: Source["kind"];
  url: string;
  publisher: string | null;
  tier: Source["tier"];
  every_seconds: number;
  use: string;
  terms_checked: string | null;
  terms_note: string | null;
  fetch_pages: boolean;
  vouches: string[];
}

/** An interval back to the file's form: `30m`, `6h`, `1d`. */
export function everyOf(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  return `${Math.round(seconds / 60)}m`;
}

/** A row as sources.yaml would have it; defaults are left out, as a person would write it. */
export function sourceFromRow(r: SourceRow): Source {
  return {
    id: r.slug,
    kind: r.kind,
    url: r.url,
    ...(r.publisher && { publisher: r.publisher }),
    tier: r.tier,
    every: everyOf(r.every_seconds),
    ...(r.use !== "leads" && { use: r.use as Source["use"] }),
    ...(r.terms_checked && { terms_checked: r.terms_checked }),
    ...(r.terms_note && { terms_note: r.terms_note }),
    ...(!r.fetch_pages && { pages: false }),
    ...(r.vouches.length > 0 && { vouches: r.vouches }),
  } as Source;
}

/** A newsroom's sources as the text of its sources.yaml (D192's export). */
export function sourcesYaml(sources: Source[]): string {
  return `# Exported from Postgres; config sync only seeds sources a newsroom lacks (D192).\n${stringify(
    [...sources].sort((a, b) => a.id.localeCompare(b.id)),
    { lineWidth: 0 },
  )}`;
}
