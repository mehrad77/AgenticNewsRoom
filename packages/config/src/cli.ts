// Validates the repo's config/ tree. Run in CI by `pnpm config:check`.
import { fileURLToPath } from "node:url";
import { loadConfig } from "./load.ts";
import { validateConfig } from "./validate.ts";

const root = fileURLToPath(new URL("../../../config", import.meta.url));
const config = loadConfig(root);
const errors = validateConfig(config);
if (errors.length > 0) {
  for (const e of errors) console.error(`✗ ${e}`);
  process.exit(1);
}
console.log(
  `✓ config valid: ${config.newsrooms.length} newsrooms, ${config.formats.length} formats`,
);
