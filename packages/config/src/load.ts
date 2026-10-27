import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export interface RawNewsroom {
  slug: string;
  dir: string;
  newsroom: unknown;
  policy: unknown;
  sources: unknown;
  series: Record<string, unknown>;
  hasStyleGuide: boolean;
}

export interface RawConfig {
  root: string;
  /** Each models file (models.yaml, models.free.yaml, …), keyed by file name. */
  models: Record<string, unknown>;
  formats: string[];
  /** Each format's format.yaml, keyed by format; undefined when missing. */
  formatMeta: Record<string, unknown>;
  newsrooms: RawNewsroom[];
}

/** Parses a YAML file, naming the file in parse errors. Missing files read as undefined. */
const readYaml = (file: string): unknown => {
  if (!existsSync(file)) return undefined;
  try {
    return parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: ${(error as Error).message}`);
  }
};

const dirs = (path: string) =>
  readdirSync(path, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => d.name)
    .sort();

/** Reads the config tree (config/ at the repo root) without validating it. */
export function loadConfig(root: string): RawConfig {
  const newsroomsDir = join(root, "newsrooms");
  const formats = dirs(join(root, "formats"));
  const formatMeta: Record<string, unknown> = {};
  for (const f of formats) formatMeta[f] = readYaml(join(root, "formats", f, "format.yaml"));
  return {
    root,
    models: Object.fromEntries(
      readdirSync(root)
        .filter((f) => /^models(\.[a-z0-9-]+)?\.yaml$/.test(f))
        .sort()
        .map((f) => [f, readYaml(join(root, f))]),
    ),
    formats,
    formatMeta,
    newsrooms: dirs(newsroomsDir).map((slug) => {
      const dir = join(newsroomsDir, slug);
      const seriesDir = join(dir, "series");
      const series: Record<string, unknown> = {};
      if (existsSync(seriesDir)) {
        for (const f of readdirSync(seriesDir)
          .filter((f) => f.endsWith(".yaml"))
          .sort()) {
          series[f.replace(/\.yaml$/, "")] = readYaml(join(seriesDir, f));
        }
      }
      return {
        slug,
        dir,
        newsroom: readYaml(join(dir, "newsroom.yaml")),
        policy: readYaml(join(dir, "policy.yaml")),
        sources: existsSync(join(dir, "sources.yaml"))
          ? (readYaml(join(dir, "sources.yaml")) ?? [])
          : undefined,
        series,
        hasStyleGuide: existsSync(join(dir, "style.md")),
      };
    }),
  };
}
