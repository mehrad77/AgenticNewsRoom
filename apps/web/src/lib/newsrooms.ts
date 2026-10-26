import { resolve } from "node:path";
import { loadConfig, validateConfig } from "@anr/config";
import type { SiteNewsroom } from "./site.ts";

// Resolved from the working directory (apps/web), not this module, so it survives bundling.
// Milestone 1 replaces this with the synced Newsroom rows in Postgres.
const configRoot = process.env.ANR_CONFIG_DIR ?? resolve(process.cwd(), "../../config");

const config = loadConfig(configRoot);
const problems = validateConfig(config);
// Fail at startup with the reasons, never route on config that does not match its schema.
if (problems.length > 0)
  throw new Error(`invalid config in ${configRoot}:\n${problems.join("\n")}`);

export const newsrooms: SiteNewsroom[] = config.newsrooms.map((n) => n.newsroom as SiteNewsroom);

export const rootDomain = process.env.ANR_ROOT_DOMAIN ?? "localhost";
