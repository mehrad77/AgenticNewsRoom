// Models at the desk, for the platform admin only: the role chains in force (the models file's, or
// the admin's in `platform_settings`, by the agents worker's own rule: @anr/config effectiveRoles),
// and the local model server's (LM Studio's) models, loaded and unloaded through its REST API.
// What can exist, at what price, stays reviewed configuration: the admin only orders catalog ids.
import { effectiveRoles, formatNames, parseRoles, roleProblems } from "@anr/config";
import { MODEL_ROLES_KEY } from "@anr/core";
import type { Client, Pool } from "@anr/db";
import { loadModelsConfig, type ModelsConfig, modelsFile } from "@anr/models";
import { DeskError } from "./errors.ts";
import { audit, inTransaction } from "./ops.ts";

type Actor = { kind: "person"; userId: string };
type Db = Pick<Client, "query">;

/** The models file (ANR_MODELS profile) and the formats a desk chain may be set for. */
export interface ModelsSetup {
  config: ModelsConfig;
  formats: string[];
}

export function modelsSetup(configDir: string): ModelsSetup {
  return { config: loadModelsConfig(modelsFile(configDir)), formats: formatNames(configDir) };
}

/** A provider is local when it is OpenAI-compatible at a plain-http address (D183). */
const isLocal = (p: ModelsConfig["providers"][string]) =>
  p.kind === "openai" && p.base_url.startsWith("http://");

async function stored(db: Db, lock = false): Promise<unknown> {
  const { rows } = await db.query<{ value: unknown }>(
    `select value from platform_settings where key = $1${lock ? " for update" : ""}`,
    [MODEL_ROLES_KEY],
  );
  return rows[0]?.value;
}

/** The catalog, the chains in force and their source, and the models file's own chains. */
export async function adminModels(db: Db, setup: ModelsSetup) {
  const { config, formats } = setup;
  const effective = effectiveRoles(config, await stored(db), formats);
  return {
    catalog: Object.entries(config.models).map(([id, m]) => {
      const provider = config.providers[m.provider];
      return {
        id,
        provider: m.provider,
        provider_kind: provider?.kind ?? "unknown",
        model: m.model,
        family: m.family,
        tools: m.tools,
        price: m.price ?? null,
        local: provider ? isLocal(provider) : false,
      };
    }),
    formats,
    roles: effective.roles,
    source: effective.source,
    problems: effective.problems,
    file_roles: config.roles,
  };
}

async function save(pool: Pool, actor: Actor, action: string, value: unknown) {
  await inTransaction(pool, async (client) => {
    const before = await stored(client, true);
    // JSON null, not a delete: no role may delete a platform setting, and null reads as the file's.
    await client.query(
      `insert into platform_settings (key, value, updated_by, updated_at) values ($1, $2, $3, now())
       on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by,
                                       updated_at = excluded.updated_at`,
      [MODEL_ROLES_KEY, JSON.stringify(value), actor.userId],
    );
    await audit(client, actor, action, "platform_settings", MODEL_ROLES_KEY, before ?? null, value);
  });
}

/** Saves every role's chain after checking it against the catalog; refused with each problem. */
export async function setModelRoles(pool: Pool, actor: Actor, setup: ModelsSetup, body: unknown) {
  const parsed = parseRoles(body);
  const problems =
    "problems" in parsed
      ? parsed.problems
      : roleProblems(setup.config, parsed.roles, setup.formats);
  if ("problems" in parsed || problems.length > 0)
    throw new DeskError(400, `the chains are not valid: ${problems.join("; ")}`, problems);
  await save(pool, actor, "set", parsed.roles);
  return adminModels(pool, setup);
}

/** Goes back to the models file's chains. */
export async function resetModelRoles(pool: Pool, actor: Actor, setup: ModelsSetup) {
  await save(pool, actor, "reset", null);
  return adminModels(pool, setup);
}

// The local model server (LM Studio) and its native REST API.

/** How long listing may take; the page waits on it. */
const LIST_TIMEOUT_MS = 5_000;
/** Loading reads the weights into memory, about 15 s for a 20B model; a larger one takes longer. */
const LOAD_TIMEOUT_MS = 180_000;
const UNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_CONTEXT = 65_536;
const MIN_CONTEXT = 4_096;

export interface LocalServer {
  provider: string;
  /** The server's root: the provider's base_url without `/v1`. */
  url: string;
}

/** The first local OpenAI-compatible provider in the models file, if any. */
export function localServer(config: ModelsConfig): LocalServer | undefined {
  for (const [provider, p] of Object.entries(config.providers)) {
    if (p.kind === "openai" && isLocal(p))
      return { provider, url: p.base_url.replace(/\/+$/, "").replace(/\/v1$/, "") };
  }
  return undefined;
}

function server(setup: ModelsSetup): LocalServer {
  const s = localServer(setup.config);
  if (!s) throw new DeskError(404, "the models file has no local model server");
  return s;
}

async function lmstudio(
  s: LocalServer,
  fetchFn: typeof fetch,
  path: string,
  timeoutMs: number,
  body?: unknown,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(`${s.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if ((error as Error).name === "TimeoutError")
      throw new DeskError(
        503,
        `LM Studio at ${s.url} did not answer within ${timeoutMs / 1000} s${body === undefined ? "" : "; it may still be working on it"}`,
      );
    throw new DeskError(503, `LM Studio is not running at ${s.url}`);
  }
  const json = (await res.json().catch(() => null)) as {
    error?: string | { message?: string };
  } | null;
  if (!res.ok) {
    const e = json?.error;
    const said = typeof e === "string" ? e : e?.message;
    throw new DeskError(502, `LM Studio at ${s.url} refused: ${said ?? `HTTP ${res.status}`}`);
  }
  return json;
}

interface RawModel {
  type?: string;
  key?: string;
  display_name?: string;
  size_bytes?: number;
  params_string?: string | null;
  max_context_length?: number;
  loaded_instances?: { id?: string; config?: { context_length?: number } }[];
  capabilities?: { trained_for_tool_use?: boolean };
}

const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : null);

/** The server's language models (embedding models are left out), with their loaded instances. */
export async function localModels(setup: ModelsSetup, fetchFn: typeof fetch = fetch) {
  const s = server(setup);
  const raw = (await lmstudio(s, fetchFn, "/api/v1/models", LIST_TIMEOUT_MS)) as {
    models?: RawModel[];
  } | null;
  const catalog = Object.entries(setup.config.models);
  return {
    provider: s.provider,
    url: s.url,
    models: (Array.isArray(raw?.models) ? raw.models : [])
      .filter((m): m is RawModel & { key: string } => m.type === "llm" && typeof m.key === "string")
      .map((m) => ({
        key: m.key,
        display_name: m.display_name ?? m.key,
        size_bytes: int(m.size_bytes),
        params: m.params_string ?? null,
        max_context_length: int(m.max_context_length),
        tool_use: m.capabilities?.trained_for_tool_use === true,
        loaded: (m.loaded_instances ?? []).flatMap((i) =>
          typeof i.id === "string"
            ? [{ id: i.id, context_length: int(i.config?.context_length) }]
            : [],
        ),
        catalog_ids: catalog
          .filter(([, c]) => c.provider === s.provider && c.model === m.key)
          .map(([id]) => id),
      })),
  };
}

/**
 * Loads a model the server lists, with a context length from 4,096 to the model's maximum: by
 * default 65,536, or the maximum when that is smaller. Audited once LM Studio has loaded it.
 */
export async function loadLocalModel(
  pool: Pool,
  actor: Actor,
  setup: ModelsSetup,
  body: Record<string, unknown>,
  fetchFn: typeof fetch = fetch,
) {
  const s = server(setup);
  if (typeof body.model !== "string" || body.model === "")
    throw new DeskError(400, "model: a model key LM Studio lists");
  const { models } = await localModels(setup, fetchFn);
  const model = models.find((m) => m.key === body.model);
  if (!model) throw new DeskError(400, `model: LM Studio lists no language model ${body.model}`);
  const max = model.max_context_length;
  const contextLength =
    body.context_length === undefined
      ? Math.min(DEFAULT_CONTEXT, max ?? DEFAULT_CONTEXT)
      : body.context_length;
  if (
    typeof contextLength !== "number" ||
    !Number.isInteger(contextLength) ||
    contextLength < MIN_CONTEXT ||
    (max !== null && contextLength > max)
  )
    throw new DeskError(
      400,
      `context_length: a whole number from ${MIN_CONTEXT} to ${max ?? "the model's maximum"}`,
    );
  const answer = (await lmstudio(s, fetchFn, "/api/v1/models/load", LOAD_TIMEOUT_MS, {
    model: model.key,
    context_length: contextLength,
  })) as { instance_id?: unknown } | null;
  const instanceId = typeof answer?.instance_id === "string" ? answer.instance_id : null;
  const after = { model: model.key, context_length: contextLength, instance_id: instanceId };
  await audit(pool, actor, "load", "local_model", model.key, { loaded: model.loaded }, after);
  return after;
}

/** Unloads one loaded instance. Audited once LM Studio has unloaded it. */
export async function unloadLocalModel(
  pool: Pool,
  actor: Actor,
  setup: ModelsSetup,
  body: Record<string, unknown>,
  fetchFn: typeof fetch = fetch,
) {
  const s = server(setup);
  const instanceId = body.instance_id;
  if (typeof instanceId !== "string" || instanceId === "" || instanceId.length > 300)
    throw new DeskError(400, "instance_id: a loaded instance's id");
  const { models } = await localModels(setup, fetchFn);
  const model = models.find((m) => m.loaded.some((i) => i.id === instanceId));
  const instance = model?.loaded.find((i) => i.id === instanceId);
  if (!model || !instance) throw new DeskError(404, `no loaded instance ${instanceId}`);
  await lmstudio(s, fetchFn, "/api/v1/models/unload", UNLOAD_TIMEOUT_MS, {
    instance_id: instanceId,
  });
  await audit(pool, actor, "unload", "local_model", model.key, instance, null);
  return { ok: true };
}
