import { fileURLToPath } from "node:url";
import { createBoss, createPool, platformKey, startHeartbeat } from "@anr/db";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { accessVerifier } from "./desk/access.ts";
import { ttsCatalog } from "./desk/tts.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");
// Only sends jobs (a returned assignment's re-draft, a channel check); it works no queue.
const boss = createBoss(connectionString, "api", { supervise: false, schedule: false });
await boss.start();

const pool = createPool(connectionString);
startHeartbeat(pool, "api");
const app = createApp({
  pool,
  boss,
  platform: platformKey(),
  verify: accessVerifier({
    teamDomain: process.env.CF_ACCESS_TEAM_DOMAIN || undefined,
    audience: process.env.CF_ACCESS_AUD || undefined,
    rootDomain: process.env.ANR_ROOT_DOMAIN ?? "localhost",
    devEmail: process.env.ANR_DESK_DEV_EMAIL || undefined,
  }),
  site: {
    rootDomain: process.env.ANR_ROOT_DOMAIN ?? "localhost",
    devPort: Number(process.env.WEB_PORT ?? 4321),
  },
  tts: ttsCatalog(
    process.env.ANR_CONFIG_DIR ?? fileURLToPath(new URL("../../../config", import.meta.url)),
  ),
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => console.log(`api listening on :${info.port}`));
