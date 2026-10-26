import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rootEnv = fileURLToPath(new URL("../../../.env", import.meta.url));

/** Loads the repo-root .env into process.env when present; variables already set win. */
export function loadRootEnv(): void {
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
}
