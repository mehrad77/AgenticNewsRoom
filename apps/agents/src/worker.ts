// Agents worker: each agent run is one pg-boss job that runs one LangGraph.js graph and ends
// with one submit. Graphs are registered here as they are built (milestones 2, 3 and 5).
import { fileURLToPath } from "node:url";
import { createBoss, createPool } from "@anr/db";
import { buildCatalog, loadModelsConfig, ModelGateway, missingKeys, modelsFile } from "@anr/models";
import { handleIngestSource, ingestionClient } from "./ingest.ts";
import { registerJobs } from "./jobs.ts";
import { ModelRouter } from "./router.ts";
import { gatewayModel } from "./summariser/model.ts";
import { enqueueSummaries, resumeSummaries, summariserHandler } from "./summariser/run.ts";
import { Throttle } from "./throttle.ts";

const configDir =
  process.env.ANR_CONFIG_DIR ?? fileURLToPath(new URL("../../../config", import.meta.url));
const models = loadModelsConfig(modelsFile(configDir));
const router = new ModelRouter(models);
const catalog = buildCatalog(models);
const gateway = new ModelGateway(catalog);
const missing = missingKeys(catalog);
if (missing.length > 0)
  console.warn(`[agents] models without keys are skipped: ${missing.join(", ")}`);
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const pool = createPool(connectionString);
const boss = createBoss(connectionString, "agents");
await boss.start();
const ingestion = ingestionClient(process.env.ANR_INGESTION_URL ?? "http://127.0.0.1:8101");
// Without a key for any model in the chain, summariser jobs stay queued rather than spend their retries failing.
const summariserChain = router.resolve("summariser");
const canSummarise = summariserChain.some((id) => catalog.entries.get(id)?.apiKey);
await registerJobs(boss, {
  "ingest-source": async (job) => {
    await handleIngestSource(job, {
      ingestion,
      onNewLeads: async (newsroomId, ids) => {
        await enqueueSummaries(pool, boss, router, newsroomId, ids);
      },
    });
    await resumeSummaries(pool, boss, router);
  },
  // Only the summariser has a graph so far; other roles arrive with milestones 3 and 5.
  ...(canSummarise && {
    "agent-run": summariserHandler({
      pool,
      boss,
      router,
      makeModel: (chain) => gatewayModel(gateway, chain),
      throttle: Throttle.perMinute(Number(process.env.ANR_SUMMARISER_RPM ?? 10)),
    }),
  }),
});
if (canSummarise) {
  const resumed = await resumeSummaries(pool, boss, router);
  if (resumed > 0) console.log(`[agents] resumed ${resumed} unfinished summaries`);
} else {
  console.warn(
    `[agents] no key for any summariser model (${summariserChain.join(", ")}): summaries wait in the queue until one is set`,
  );
}
console.log(
  `agents worker started (${modelsFile(configDir)}); summariser chain ${summariserChain.join(" → ")}`,
);

const stop = async () => {
  await boss.stop();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
