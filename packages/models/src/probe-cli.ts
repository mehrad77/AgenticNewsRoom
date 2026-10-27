// `pnpm models:probe [profile]`: one tool-call ping per model in the role chains of
// models.yaml, or models.<profile>.yaml (default: ANR_MODELS). Makes real, free-tier calls.
import { fileURLToPath } from "node:url";
import { langchainClient } from "./adapters.ts";
import { buildCatalog, loadModelsConfig, modelsFile } from "./catalog.ts";
import { BROKEN, probe } from "./probe.ts";

const configDir =
  process.env.ANR_CONFIG_DIR ?? fileURLToPath(new URL("../../../config", import.meta.url));
const file = modelsFile(configDir, process.argv[2] ?? process.env.ANR_MODELS);
console.log(`probing ${file}`);
const rows = await probe(buildCatalog(loadModelsConfig(file)), langchainClient);
const width = Math.max(...rows.map((r) => r.catalogId.length));
for (const r of rows) {
  const mark = r.outcome === "ok" ? "✓" : BROKEN.has(r.outcome) ? "✗" : "·";
  const detail = r.detail ? `  ${r.detail.slice(0, 120)}` : "";
  console.log(`${mark} ${r.catalogId.padEnd(width)}  ${r.outcome.padEnd(12)} ${r.model}${detail}`);
}
const broken = rows.filter((r) => BROKEN.has(r.outcome));
if (broken.length > 0) {
  console.error(`${broken.length} model(s) need a change in ${file}`);
  process.exit(1);
}
