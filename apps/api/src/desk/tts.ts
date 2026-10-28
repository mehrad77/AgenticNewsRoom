// Text-to-speech engines at the desk (D113): the platform admin enables engines from the models
// file's catalogue; each newsroom's Editor-in-Chief picks one per language from those. The engine
// a language would use now follows the publisher's own rule (chooseEngine in @anr/core).
import { chooseEngine, enabledEngines, type Language, TTS_ENGINES_KEY } from "@anr/core";
import { type Client, type Pool, recordAudit } from "@anr/db";
import { buildCatalog, loadModelsConfig, modelsFile } from "@anr/models";
import { DeskError } from "./errors.ts";

type Actor = { kind: "person"; userId: string };

/** The engines the models file catalogues (`tts_engines`), and its default (`tts`). */
export interface TtsCatalog {
  default: string;
  engines: { id: string; model: string; languages: Language[]; local: boolean }[];
}

/** The catalogue as the models file (ANR_MODELS profile) has it; keys are not needed here. */
export function ttsCatalog(configDir: string): TtsCatalog {
  const catalog = buildCatalog(loadModelsConfig(modelsFile(configDir)));
  const ids = catalog.config.tts_engines ?? [catalog.config.tts];
  return {
    default: catalog.config.tts,
    engines: ids.flatMap((id) => {
      const e = catalog.entries.get(id);
      return e
        ? [
            {
              id,
              model: e.model,
              languages: (e.languages ?? []) as Language[],
              local: e.kind === "local-tts",
            },
          ]
        : [];
    }),
  };
}

async function enabled(db: Pick<Client, "query">, catalog: TtsCatalog): Promise<string[]> {
  const { rows } = await db.query<{ value: unknown }>(
    "select value from platform_settings where key = $1",
    [TTS_ENGINES_KEY],
  );
  return enabledEngines(
    rows[0]?.value,
    catalog.engines.map((e) => e.id),
    catalog.default,
  );
}

export async function adminTts(pool: Pool, catalog: TtsCatalog) {
  const on = await enabled(pool, catalog);
  return {
    default: catalog.default,
    engines: catalog.engines.map((e) => ({ ...e, enabled: on.includes(e.id) })),
  };
}

/** Saves the engines newsrooms may choose, in the platform audit log with before and after. */
export async function setAdminTts(pool: Pool, actor: Actor, catalog: TtsCatalog, ids: unknown) {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
    throw new DeskError(400, "engines: a list of engine ids");
  const unknown = ids.filter((id) => !catalog.engines.some((e) => e.id === id));
  if (unknown.length > 0) throw new DeskError(400, `not in the models file: ${unknown.join(", ")}`);
  const next = [...new Set(ids as string[])];
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{ value: unknown }>(
      "select value from platform_settings where key = $1 for update",
      [TTS_ENGINES_KEY],
    );
    await client.query(
      `insert into platform_settings (key, value, updated_by, updated_at) values ($1, $2, $3, now())
       on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by,
                                       updated_at = excluded.updated_at`,
      [TTS_ENGINES_KEY, JSON.stringify(next), actor.userId],
    );
    await client.query(
      `insert into platform_audit_log (actor_user_id, action, entity, key, before, after)
       values ($1, 'set', 'platform_settings', $2, $3, $4)`,
      [actor.userId, TTS_ENGINES_KEY, JSON.stringify(rows[0]?.value ?? null), JSON.stringify(next)],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  return { id: TTS_ENGINES_KEY, status: "saved" };
}

/** Per newsroom language: its choice, the engine it would use now and why, and its options. */
export async function newsroomTts(client: Client, catalog: TtsCatalog) {
  const on = await enabled(client, catalog);
  const { rows: n } = await client.query<{ languages: Language[] }>(
    "select languages from newsrooms where id = anr.current_newsroom_id()",
  );
  const { rows: chosen } = await client.query<{ language: string; engine: string }>(
    "select language, engine from newsroom_tts",
  );
  return {
    default: catalog.default,
    languages: (n[0]?.languages ?? []).map((language) => {
      const pick = chosen.find((c) => c.language === language)?.engine ?? null;
      const choice = chooseEngine(language, pick, on, catalog.default, catalog.engines);
      return {
        language,
        chosen: pick,
        effective: choice.ok ? choice.engine : null,
        source: choice.ok ? choice.source : null,
        reason: choice.ok ? null : choice.reason,
        options: catalog.engines
          .filter((e) => on.includes(e.id) && e.languages.includes(language))
          .map((e) => e.id),
      };
    }),
  };
}

/** Chooses (or with null clears) a language's engine; audited in the newsroom's log. */
export async function setNewsroomTts(
  client: Client,
  actor: Actor,
  catalog: TtsCatalog,
  language: string,
  engine: string | null,
) {
  const { rows: n } = await client.query<{ languages: string[] }>(
    "select languages from newsrooms where id = anr.current_newsroom_id()",
  );
  if (!n[0]?.languages.includes(language))
    throw new DeskError(400, `language: one of ${n[0]?.languages.join(", ")}`);
  if (engine !== null) {
    const info = catalog.engines.find((e) => e.id === engine);
    if (!info || !(await enabled(client, catalog)).includes(engine))
      throw new DeskError(400, `engine ${engine} is not enabled on this platform`);
    if (!info.languages.includes(language as Language))
      throw new DeskError(400, `engine ${engine} does not speak ${language}`);
  }
  const { rows: before } = await client.query<{ id: string; engine: string }>(
    "select id, engine from newsroom_tts where language = $1 for update",
    [language],
  );
  let id = before[0]?.id;
  if (engine === null) {
    if (id) await client.query("delete from newsroom_tts where id = $1", [id]);
  } else {
    const { rows } = await client.query<{ id: string }>(
      `insert into newsroom_tts (newsroom_id, language, engine)
       values (anr.current_newsroom_id(), $1, $2)
       on conflict (newsroom_id, language) do update set engine = excluded.engine, updated_at = now()
       returning id`,
      [language, engine],
    );
    id = rows[0]?.id;
  }
  if (id) {
    await recordAudit(client, {
      actor,
      action: engine === null ? "clear" : "choose",
      entity: "newsroom_tts",
      entityId: id,
      before: before[0] ? { language, engine: before[0].engine } : null,
      after: engine === null ? null : { language, engine },
    });
  }
  return { id: id ?? language, status: engine === null ? "cleared" : "chosen" };
}
