import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { type ModelsSchema, roleChains } from "@anr/schemas";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { RawConfig } from "./load.ts";
import { cronDaily, cronEvery } from "./schedules.ts";

const require = createRequire(import.meta.url);
const schemaPath = (name: string) => require.resolve(`@anr/schemas/json/${name}.schema.json`);
// ajv-formats ships CommonJS; its default export arrives wrapped under ESM.
const addFormats = (addFormatsModule as unknown as { default: typeof addFormatsModule }).default;

interface IptcScheme {
  concepts: { qcode: string; retired?: string }[];
}
const qcodeCache = new Map<string, Set<string>>();
/** Live (not retired) qcodes of a vendored IPTC vocabulary (packages/schemas/iptc/), read once. */
const liveQcodes = (scheme: string): Set<string> => {
  let codes = qcodeCache.get(scheme);
  if (!codes) {
    const file = require.resolve(`@anr/schemas/iptc/${scheme}.json`);
    const { concepts } = JSON.parse(readFileSync(file, "utf8")) as IptcScheme;
    codes = new Set(concepts.filter((c) => !c.retired).map((c) => c.qcode));
    qcodeCache.set(scheme, codes);
  }
  return codes;
};

const CHANNEL_TEMPLATE: Record<string, string> = {
  site: "site.liquid",
  telegram: "telegram.liquid",
  "podcast-rss": "podcast-rss.liquid",
};

/** Cross-references in a models file that JSON Schema cannot express (D22, D71). */
function modelsProblems(m: ModelsSchema, file: string, formats: string[]): string[] {
  const errors: string[] = [];
  for (const [id, p] of Object.entries(m.providers)) {
    if (p.kind === "openai" && p.base_url.includes("{account}") && !p.account_env) {
      errors.push(`${file} provider ${id}: base_url has {account} but no account_env`);
    }
    // A local server (plain http, no key) is for development profiles only (D84).
    if (file === "models.yaml" && p.kind === "openai" && !p.base_url.startsWith("https://")) {
      errors.push(`${file} provider ${id}: a local server belongs in a development profile`);
    }
    if (file === "models.yaml" && !p.key_env) {
      errors.push(`${file} provider ${id}: needs key_env`);
    }
  }
  for (const [id, model] of Object.entries(m.models)) {
    if (!m.providers[model.provider]) {
      errors.push(`${file} model ${id}: unknown provider ${model.provider}`);
    }
    if (model.reasoning_effort && m.providers[model.provider]?.kind !== "openai") {
      errors.push(`${file} model ${id}: reasoning_effort needs an OpenAI-compatible provider`);
    }
    // OpenRouter's :online variants search the web; agents have no web access (invariant 2).
    if (model.model.endsWith(":online")) {
      errors.push(`${file} model ${id}: ${model.model} has web access`);
    }
  }
  const chains = roleChains(m);
  for (const format of Object.keys(m.roles.desk.by_format ?? {})) {
    if (!formats.includes(format)) errors.push(`${file} desk.by_format: unknown format ${format}`);
  }
  for (const [role, chain] of chains) {
    for (const id of chain) {
      const model = m.models[id];
      if (!model) errors.push(`${file} ${role}: unknown model ${id}`);
      // Every agent ends with the submit tool.
      else if (!model.tools) errors.push(`${file} ${role}: ${id} has no tool calling`);
      // Budgets count spend from prices; an unpriced model would spend unseen (D82).
      else if (!model.price) errors.push(`${file} ${role}: ${id} has no price`);
    }
  }
  if (!m.models[m.tts]) errors.push(`${file} tts: unknown model ${m.tts}`);
  else if (!m.models[m.tts]?.price) errors.push(`${file} tts: ${m.tts} has no price`);
  const families = new Set(m.roles["fact-checker"].flatMap((id) => m.models[id]?.family ?? []));
  if (families.size < 2) {
    errors.push(`${file} fact-checker needs models from at least two families`);
  }
  return errors;
}

/** Returns a list of human-readable problems; empty means the config is valid. */
export function validateConfig(config: RawConfig): string[] {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validator = (name: string) =>
    ajv.compile(JSON.parse(readFileSync(schemaPath(name), "utf8")));
  const v = {
    models: validator("models"),
    newsroom: validator("newsroom"),
    policy: validator("policy"),
    sources: validator("sources"),
    series: validator("series"),
    format: validator("format"),
  };
  const mediaTopics = liveQcodes("mediatopic");
  const genres = liveQcodes("genre");
  const errors: string[] = [];
  const check = (fn: (typeof v)[keyof typeof v], data: unknown, where: string) => {
    if (!fn(data)) {
      for (const e of fn.errors ?? []) errors.push(`${where}${e.instancePath} ${e.message}`);
      return false;
    }
    return true;
  };

  if (config.models["models.yaml"] === undefined) errors.push("config has no models.yaml");
  for (const [file, data] of Object.entries(config.models)) {
    if (check(v.models, data, file)) {
      errors.push(...modelsProblems(data as ModelsSchema, file, config.formats));
    }
  }

  for (const format of config.formats) {
    if (!existsSync(join(config.root, "formats", format, "schema.json"))) {
      errors.push(`formats/${format} has no schema.json`);
    }
    const meta = config.formatMeta[format];
    const where = `formats/${format}/format.yaml`;
    if (meta === undefined) errors.push(`formats/${format} has no format.yaml`);
    else if (check(v.format, meta, where)) {
      const { genre } = meta as { genre: string };
      if (!genres.has(genre)) errors.push(`${where} genre ${genre} is not a live IPTC genre`);
    }
  }

  const subdomains = new Map<string, string>();
  for (const n of config.newsrooms) {
    const at = `newsrooms/${n.slug}`;
    if (!n.hasStyleGuide) errors.push(`${at} has no style.md`);
    const files = { newsroom: n.newsroom, policy: n.policy, sources: n.sources };
    const missing = Object.entries(files).filter(([, data]) => data === undefined);
    for (const [file] of missing) errors.push(`${at} has no ${file}.yaml`);
    if (missing.length > 0) continue;
    const okNewsroom = check(v.newsroom, n.newsroom, `${at}/newsroom.yaml`);
    const okPolicy = check(v.policy, n.policy, `${at}/policy.yaml`);
    check(v.sources, n.sources, `${at}/sources.yaml`);
    if (!okNewsroom) continue;

    const newsroom = n.newsroom as {
      slug: string;
      languages: string[];
      subdomain: string;
      timezone: string;
    };
    if (newsroom.slug !== n.slug) errors.push(`${at}/newsroom.yaml slug must equal folder name`);
    try {
      new Intl.DateTimeFormat("en", { timeZone: newsroom.timezone });
    } catch {
      errors.push(`${at}/newsroom.yaml timezone ${newsroom.timezone} is not an IANA timezone`);
    }
    const other = subdomains.get(newsroom.subdomain);
    if (other) errors.push(`${at} reuses subdomain of newsrooms/${other}`);
    subdomains.set(newsroom.subdomain, n.slug);

    const sources = (Array.isArray(n.sources) ? n.sources : []) as { id: string; every: string }[];
    const sourceIds = sources.map((s) => s.id);
    if (new Set(sourceIds).size !== sourceIds.length)
      errors.push(`${at}/sources.yaml has duplicate ids`);
    for (const s of sources) {
      try {
        cronEvery(s.every);
      } catch (error) {
        errors.push(`${at}/sources.yaml source ${s.id}: ${(error as Error).message}`);
      }
    }

    if (okPolicy) {
      const beats = (n.policy as { beats: Record<string, { media_topics: string[] }> }).beats;
      for (const [beat, { media_topics }] of Object.entries(beats)) {
        for (const t of media_topics) {
          if (!mediaTopics.has(t))
            errors.push(`${at}/policy.yaml beat ${beat}: ${t} is not a live IPTC Media Topic`);
        }
      }
      for (const f of (n.policy as { auto_publish: string[] }).auto_publish) {
        if (!config.formats.includes(f))
          errors.push(`${at}/policy.yaml auto_publish names unknown format ${f}`);
      }
    }

    for (const [name, s] of Object.entries(n.series)) {
      const where = `${at}/series/${name}.yaml`;
      if (!check(v.series, s, where)) continue;
      const series = s as {
        format: string;
        languages: string[];
        channels: Record<string, string[]>;
        segments?: { kind: string; from: string }[];
        hosts?: Record<string, Record<string, string>>;
        narrator?: Record<string, string>;
        assignment_at?: string;
      };
      if (series.assignment_at !== undefined) {
        try {
          cronDaily(series.assignment_at);
        } catch (error) {
          errors.push(`${where} assignment_at: ${(error as Error).message}`);
        }
      }
      if (!config.formats.includes(series.format))
        errors.push(`${where} uses unknown format ${series.format}`);
      for (const l of series.languages) {
        if (!newsroom.languages.includes(l))
          errors.push(`${where} language ${l} is not a newsroom language`);
      }
      for (const [kind, langs] of Object.entries(series.channels)) {
        for (const l of langs) {
          if (!series.languages.includes(l))
            errors.push(`${where} channel ${kind} uses language ${l} the series does not write`);
        }
        const template = join(
          config.root,
          "formats",
          series.format,
          "templates",
          CHANNEL_TEMPLATE[kind] ?? "",
        );
        if (config.formats.includes(series.format) && !existsSync(template)) {
          errors.push(
            `${where} sends to ${kind} but format ${series.format} has no ${CHANNEL_TEMPLATE[kind]}`,
          );
        }
      }
      for (const seg of series.segments ?? []) {
        const from = seg.from.replace(/^week\./, "");
        if (!(from in n.series)) errors.push(`${where} segment reads from unknown series ${from}`);
      }
      if (series.format === "podcast-episode") {
        for (const l of series.languages) {
          if (!series.hosts?.[l]) errors.push(`${where} has no hosts for ${l}`);
          const tellsStory = (series.segments ?? []).some((seg) => seg.kind === "story");
          if (tellsStory && !series.narrator?.[l])
            errors.push(`${where} has no narrator voice for ${l}`);
        }
      }
    }
  }
  return errors;
}
