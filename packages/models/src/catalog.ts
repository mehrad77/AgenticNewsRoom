import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ModelsSchema } from "@anr/schemas";
import { parse } from "yaml";

export type ModelsConfig = ModelsSchema;
export type Limits = NonNullable<ModelsConfig["models"][string]["limits"]>;

/** One catalog model with its provider and credentials resolved from the environment. */
export interface CatalogEntry {
  id: string;
  provider: string;
  kind: "google" | "openai";
  /** The provider's model id. */
  model: string;
  /** The weights, whoever serves them. */
  family: string;
  tools: boolean;
  baseUrl?: string;
  /** Undefined when an env var it needs is unset (see missingEnv): the gateway skips it. */
  apiKey?: string;
  /** Env vars the provider needs that are unset. */
  missingEnv: string[];
  limits?: Limits;
  /** Limits shared by every model of the provider (one account). */
  providerLimits?: Limits;
  price?: { in: number; out: number };
}

export interface Catalog {
  config: ModelsConfig;
  entries: ReadonlyMap<string, CatalogEntry>;
}

/** models.yaml, or models.<profile>.yaml for ANR_MODELS=<profile> (e.g. free). */
export function modelsFile(configDir: string, profile = process.env.ANR_MODELS): string {
  if (profile && !/^[a-z0-9-]+$/.test(profile)) throw new Error(`bad ANR_MODELS: ${profile}`);
  return join(configDir, profile ? `models.${profile}.yaml` : "models.yaml");
}

export function loadModelsConfig(file: string): ModelsConfig {
  return ModelsSchema.parse(parse(readFileSync(file, "utf8")));
}

/** Resolves every catalog model against the environment. Missing keys are not an error here. */
export function buildCatalog(
  config: ModelsConfig,
  env: Record<string, string | undefined> = process.env,
): Catalog {
  const entries = new Map<string, CatalogEntry>();
  for (const [id, m] of Object.entries(config.models)) {
    const p = config.providers[m.provider];
    if (!p) throw new Error(`model ${id}: unknown provider ${m.provider}`);
    const needed = [p.key_env, ...(p.kind === "openai" && p.account_env ? [p.account_env] : [])];
    const missingEnv = needed.filter((name) => !env[name]);
    const baseUrl =
      p.kind === "openai"
        ? p.base_url.replace("{account}", env[p.account_env ?? ""] ?? "")
        : undefined;
    entries.set(id, {
      id,
      provider: m.provider,
      kind: p.kind,
      model: m.model,
      family: m.family,
      tools: m.tools,
      baseUrl,
      apiKey: missingEnv.length === 0 ? env[p.key_env] : undefined,
      missingEnv,
      limits: m.limits,
      providerLimits: p.limits,
      price: m.price,
    });
  }
  return { config, entries };
}

/** Env vars a role chain or TTS needs but the environment lacks, for a startup warning. */
export function missingKeys(catalog: Catalog): string[] {
  const used = new Set([...roleChains(catalog.config).flatMap(([, c]) => c), catalog.config.tts]);
  const missing = new Set<string>();
  for (const id of used) {
    const e = catalog.entries.get(id);
    for (const name of e?.missingEnv ?? []) missing.add(name);
  }
  return [...missing].sort();
}

/** Every role chain, named (desk formats as desk.by_format.<format>). */
export function roleChains(config: ModelsConfig): [string, string[]][] {
  const r = config.roles;
  return [
    ["planner", r.planner],
    ["desk", r.desk.default],
    ...Object.entries(r.desk.by_format ?? {}).map(([f, c]): [string, string[]] => [
      `desk.by_format.${f}`,
      c,
    ]),
    ["renderer", r.renderer],
    ["fact-checker", r["fact-checker"]],
    ["item-matcher", r["item-matcher"]],
    ["summariser", r.summariser],
  ];
}
