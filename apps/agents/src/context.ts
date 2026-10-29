// What a run needs from config/ besides the database: a format's per-run token cap (D76) and its
// draft schema.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const cache = new Map<string, { run_tokens: number }>();

export function formatMeta(configDir: string, format: string): { run_tokens: number } {
  const key = `${configDir}:${format}`;
  let meta = cache.get(key);
  if (!meta) {
    meta = parse(readFileSync(join(configDir, "formats", format, "format.yaml"), "utf8")) as {
      run_tokens: number;
    };
    cache.set(key, meta);
  }
  return meta;
}

/** A format's draft JSON Schema (`config/formats/<format>/schema.json`). */
export function formatSchema(configDir: string, format: string): unknown {
  return JSON.parse(readFileSync(join(configDir, "formats", format, "schema.json"), "utf8"));
}

/** The language a story is first written in: the newsroom's primary one when the series has it. */
export function firstLanguage(
  newsroomLanguages: readonly string[],
  seriesLanguages: readonly string[],
): string {
  const primary = newsroomLanguages.find((l) => seriesLanguages.includes(l));
  const first = primary ?? seriesLanguages[0];
  if (!first) throw new Error("the series has no languages");
  return first;
}
