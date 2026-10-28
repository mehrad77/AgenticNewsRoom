// Which text-to-speech engine voices an episode (D113): the newsroom's choice for its language,
// when the platform admin has that engine enabled and it speaks the language; else the platform
// default under the same conditions; else none, and the episode is held with the reason.
import { chooseEngine } from "@anr/core";
import type { Client } from "@anr/db";
import type { Catalog, CatalogEntry } from "@anr/models";

/** The platform setting that lists the engines newsrooms may choose. */
export const TTS_ENGINES_KEY = "tts.engines";

/** Engines the admin has enabled; before any choice, the models file's default alone. */
export async function enabledEngines(client: Client, catalog: Catalog): Promise<string[]> {
  const { rows } = await client.query<{ value: unknown }>(
    "select value from platform_settings where key = $1",
    [TTS_ENGINES_KEY],
  );
  const offered = new Set(catalog.config.tts_engines ?? [catalog.config.tts]);
  const chosen = Array.isArray(rows[0]?.value)
    ? (rows[0]?.value as string[])
    : [catalog.config.tts];
  return chosen.filter((id) => offered.has(id));
}

export type EngineChoice =
  | { ok: true; engine: CatalogEntry; source: "newsroom" | "default" }
  | { ok: false; reason: string };

/** The catalogue's engines, as the shared rule sees them. */
export const engineInfo = (catalog: Catalog) =>
  (catalog.config.tts_engines ?? [catalog.config.tts]).map((id) => ({
    id,
    languages: catalog.entries.get(id)?.languages ?? [],
  }));

export async function engineFor(
  client: Client,
  catalog: Catalog,
  language: string,
): Promise<EngineChoice> {
  const { rows } = await client.query<{ engine: string }>(
    "select engine from newsroom_tts where language = $1",
    [language],
  );
  const choice = chooseEngine(
    language,
    rows[0]?.engine,
    await enabledEngines(client, catalog),
    catalog.config.tts,
    engineInfo(catalog),
  );
  if (!choice.ok) return choice;
  const engine = catalog.entries.get(choice.engine);
  if (!engine) return { ok: false, reason: `${choice.engine} is not in the models file` };
  return { ok: true, engine, source: choice.source };
}
