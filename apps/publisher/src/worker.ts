// Publisher: renders approved publications from templates, sends them to their channels and
// records each post idempotently, and makes each approved episode's audio. No agent is involved.
import { fileURLToPath } from "node:url";
import { createBoss, createPool, platformKey } from "@anr/db";
import { buildCatalog, loadModelsConfig, modelsFile } from "@anr/models";
import { createRenderer } from "@anr/render";
import { podcastFeed } from "./channels/feed.ts";
import { telegramChannel } from "./channels/telegram.ts";
import { checkChannel } from "./check.ts";
import { registerJobs } from "./jobs.ts";
import { type AudioDeps, produceEpisode } from "./podcast/produce.ts";
import { queueAudio } from "./podcast/queue.ts";
import { c2paSigner } from "./podcast/sign.ts";
import { localStore } from "./podcast/store.ts";
import { cachedTts, fakeTts, geminiTts, type TextToSpeech } from "./podcast/tts.ts";
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
/** `ANR_TTS=fake` voices episodes with tones, for dry runs that must not spend TTS quota. */
function textToSpeech(): TextToSpeech | null {
  if (process.env.ANR_TTS === "fake") return fakeTts();
  const models = loadModelsConfig(modelsFile(configDir));
  const entry = buildCatalog(models).entries.get(models.tts);
  return entry?.apiKey ? geminiTts(entry) : null;
}
const tts = textToSpeech();
const store = localStore(mediaDir);
const audioDeps: AudioDeps | null = tts && {
  pool,
  renderer: deps.renderer,
  tts: cachedTts(tts, store),
  store,
  signer: c2paSigner(),
  configDir,
};
if (!audioDeps) console.warn("[publisher] no TTS key: episodes wait for their audio");

const boss = createBoss(connectionString, "publisher");
await boss.start();
await registerJobs(boss, {
  sweep: async () => {
    if (audioDeps) await queueAudio(pool, boss);
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
  ...(audioDeps && {
    audio: async (job) => {
      const outcome = await produceEpisode(audioDeps, job);
      console.log(`[publisher] episode ${job.publicationId} audio: ${outcome}`);
    },
  }),
});
console.log("publisher worker started");

const stop = async () => {
  await boss.stop();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
