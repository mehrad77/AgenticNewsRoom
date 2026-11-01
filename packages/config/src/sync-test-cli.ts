// Loads the repo's formats into anr_test, which database tests across the repo build their series
// on; each test creates its own newsrooms. Part of `pnpm db:migrate`.
import { fileURLToPath } from "node:url";
import { createPool, loadRootEnv } from "@anr/db";
import { testDatabaseUrl } from "@anr/db/testing";
import { loadConfig } from "./load.ts";
import { syncNewsroomsOnly } from "./sync.ts";

loadRootEnv();
const url = process.env.DATABASE_SYSTEM_URL;
if (!url) throw new Error("DATABASE_SYSTEM_URL is not set; copy .env.example to .env");

const pool = createPool(testDatabaseUrl(url));
try {
  const config = loadConfig(fileURLToPath(new URL("../../../config", import.meta.url)));
  const { formats } = await syncNewsroomsOnly(pool, { ...config, newsrooms: [] });
  console.log(`✓ anr_test formats: ${JSON.stringify(formats)}`);
} finally {
  await pool.end();
}
