// Publisher: renders approved publications from templates, sends them to their channels and
// records each post idempotently, and makes each approved episode's audio. No agent is involved.
import { fileURLToPath } from "node:url";
import { createBoss, createPool, platformKey } from "@anr/db";
import { buildCatalog, loadModelsConfig, modelsFile } from "@anr/models";
import { createRenderer } from "@anr/render";
import { podcastFeed } from "./channels/feed.ts";
import { telegramChannel } from "./channels/telegram.ts";
import { checkChannel } from "./check.ts";
import { publishCorrections } from "./corrections.ts";
import { registerJobs } from "./jobs.ts";
import { type AudioDeps, produceEpisode } from "./podcast/produce.ts";
import { queueAudio } from "./podcast/queue.ts";
import { c2paSigner } from "./podcast/sign.ts";
import { localStore } from "./podcast/store.ts";
import { cachedTts, fakeTts, ttsFor } from "./podcast/tts.ts";
import type { PublishDeps } from "./publish.ts";
import { snapshotSubscribers } from "./stats.ts";
import { sweepDue } from "./sweep.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const pool = createPool(connectionString);
const deps: PublishDeps = {
  pool,
  renderer: createRenderer(),
  adapters: { telegram: telegramChannel(), "podcast-rss": podcastFeed() },
  platform: platformKey(),
  rootDomain: process.env.ANR_ROOT_DOMAIN ?? "localhost",
  devPort: Number(process.env.WEB_PORT ?? 4321),
};

const configDir =
  process.env.ANR_CONFIG_DIR ?? fileURLToPath(new URL("../../../config", import.meta.url));
const mediaDir =
  process.env.ANR_MEDIA_DIR ?? fileURLToPath(new URL("../../../.data/media", import.meta.url));
const store = localStore(mediaDir);
const catalog = buildCatalog(loadModelsConfig(modelsFile(configDir)));
/**
 * The engine per newsroom and language, from the engines the platform admin enabled (D113).
 * `ANR_TTS=fake` voices every episode with tones instead, for dry runs that call no engine.
 */
const audioDeps: AudioDeps = {
  pool,
  renderer: deps.renderer,
  tts:
    process.env.ANR_TTS === "fake"
      ? cachedTts(fakeTts(), store)
      : { catalog, make: (entry) => cachedTts(ttsFor(entry), store) },
  store,
  signer: c2paSigner(),
  configDir,
};

const boss = createBoss(connectionString, "publisher");
await boss.start();
await registerJobs(boss, {
  sweep: async () => {
    await queueAudio(pool, boss);
    const counts = await sweepDue(deps);
    if (Object.keys(counts).length > 0) console.log(`[publisher] sweep ${JSON.stringify(counts)}`);
  },
  stats: async () => {
    console.log(`[publisher] subscribers ${JSON.stringify(await snapshotSubscribers(deps))}`);
  },
  check: async (job) => {
    const result = await checkChannel(deps, job);
    console.log(`[publisher] channel ${job.channelId} check: ${result?.ok ?? "gone"}`);
  },
  audio: async (job) => {
    const outcome = await produceEpisode(audioDeps, job);
    console.log(`[publisher] episode ${job.publicationId} audio: ${outcome}`);
  },
  correction: async (job) => {
    const count = await publishCorrections(pool, job);
    console.log(`[publisher] challenge ${job.challengeId}: ${count} corrections published`);
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
