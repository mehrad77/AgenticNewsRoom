// Which text-to-speech engine voices an episode (D113): the newsroom's choice for its language,
// when the platform admin has that engine enabled and it speaks the language; else the platform
// default under the same conditions; else none, and the episode is held with the reason.
import { chooseEngine, enabledEngines, TTS_ENGINES_KEY } from "@anr/core";
import type { Client } from "@anr/db";
import type { Catalog, CatalogEntry } from "@anr/models";

/** Engines the admin has enabled that the models file has; before any choice, its default. */
async function enabled(client: Client, catalog: Catalog): Promise<string[]> {
  const { rows } = await client.query<{ value: unknown }>(
    "select value from platform_settings where key = $1",
    [TTS_ENGINES_KEY],
  );
  const offered = engineInfo(catalog)
    .filter((e) => catalog.entries.has(e.id))
    .map((e) => e.id);
  return enabledEngines(rows[0]?.value, offered, catalog.config.tts);
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
    await enabled(client, catalog),
    catalog.config.tts,
    engineInfo(catalog),
  );
  if (!choice.ok) return choice;
  const engine = catalog.entries.get(choice.engine);
  if (!engine) return { ok: false, reason: `${choice.engine} is not in the models file` };
  return { ok: true, engine, source: choice.source };
}
