import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dereference } from "@apidevtools/json-schema-ref-parser";

const root = new URL("..", import.meta.url).pathname;
const formatsDir = join(root, "../../config/formats");

export interface SchemaEntry {
  id: string;
  group: "config" | "format";
  title: string;
  file: string;
}

/** Every JSON Schema the platform owns: config-file schemas and format draft schemas. */
export function listSchemas(): SchemaEntry[] {
  const config = readdirSync(join(root, "json"))
    .filter((f) => f.endsWith(".schema.json"))
    .map((f) => entry(`config/${f.replace(".schema.json", "")}`, "config", join(root, "json", f)));
  const formats = readdirSync(formatsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => entry(`format/${d.name}`, "format", join(formatsDir, d.name, "schema.json")));
  return [...config, ...formats].sort((a, b) => a.id.localeCompare(b.id));
}

function entry(id: string, group: SchemaEntry["group"], file: string): SchemaEntry {
  const schema = JSON.parse(readFileSync(file, "utf8")) as { title?: string };
  return { id, group, title: schema.title ?? id, file };
}

/** The schema with every `$ref` inlined, ready to draw as a tree. */
export async function loadSchema(id: string): Promise<unknown> {
  const found = listSchemas().find((s) => s.id === id);
  if (!found) return undefined;
  return dereference(JSON.parse(readFileSync(found.file, "utf8")));
}
