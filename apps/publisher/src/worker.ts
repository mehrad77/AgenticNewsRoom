// Publisher: renders approved publications from templates, sends them to their channels and
// records each post idempotently. No agent is involved. The audio pipeline is milestone 5.
import { createBoss, createPool, platformKey } from "@anr/db";
import { createRenderer } from "@anr/render";
import { telegramChannel } from "./channels/telegram.ts";
import { registerJobs } from "./jobs.ts";
import type { PublishDeps } from "./publish.ts";
import { snapshotSubscribers } from "./stats.ts";
import { sweepDue } from "./sweep.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const pool = createPool(connectionString);
const deps: PublishDeps = {
  pool,
  renderer: createRenderer(),
  adapters: { telegram: telegramChannel() },
  platform: platformKey(),
  rootDomain: process.env.ANR_ROOT_DOMAIN ?? "localhost",
  devPort: Number(process.env.WEB_PORT ?? 4321),
};

const boss = createBoss(connectionString, "publisher");
await boss.start();
await registerJobs(boss, {
  sweep: async () => {
    const counts = await sweepDue(deps);
    if (Object.keys(counts).length > 0) console.log(`[publisher] sweep ${JSON.stringify(counts)}`);
  },
  stats: async () => {
    console.log(`[publisher] subscribers ${JSON.stringify(await snapshotSubscribers(deps))}`);
  },
});
console.log("publisher worker started");

const stop = async () => {
  await boss.stop();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
