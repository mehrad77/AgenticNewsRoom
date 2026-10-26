// Syncs config/ into Postgres as anr_system. Run at every deploy: `pnpm config:sync`.
import { fileURLToPath } from "node:url";
import { createBoss, createPool, loadRootEnv } from "@anr/db";
import { loadConfig } from "./load.ts";
import { syncConfig } from "./sync.ts";

loadRootEnv();
const url = process.env.DATABASE_SYSTEM_URL;
if (!url) throw new Error("DATABASE_SYSTEM_URL is not set");
const root =
  process.env.ANR_CONFIG_DIR ?? fileURLToPath(new URL("../../../config", import.meta.url));

const pool = createPool(url);
// A one-shot job: no cron, no maintenance; the workers do that.
const boss = createBoss(url, "config-sync", { schedule: false, supervise: false });
await boss.start();
try {
  const report = await syncConfig(pool, boss, loadConfig(root));
  for (const [what, c] of Object.entries(report)) console.log(`✓ ${what}: ${JSON.stringify(c)}`);
} finally {
  await boss.stop({ graceful: false });
  await pool.end();
}
