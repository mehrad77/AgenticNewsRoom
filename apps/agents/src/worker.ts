// Agents worker: each agent run is one pg-boss job that runs one LangGraph.js graph and ends
// with one submit. Graphs are registered here as they are built (milestones 2, 3 and 5).
import { fileURLToPath } from "node:url";
import { createBoss, createPool } from "@anr/db";
import { handleIngestSource, ingestionClient } from "./ingest.ts";
import { registerJobs } from "./jobs.ts";
import { ModelRouter } from "./router.ts";
import { chatModel } from "./summariser/model.ts";
import { enqueueSummaries, resumeSummaries, runSummariser } from "./summariser/run.ts";

const router = ModelRouter.fromFile(
  fileURLToPath(new URL("../../../config/models.yaml", import.meta.url)),
);
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const pool = createPool(connectionString);
const boss = createBoss(connectionString, "agents");
await boss.start();
const ingestion = ingestionClient(process.env.ANR_INGESTION_URL ?? "http://127.0.0.1:8101");
// Without a model key, summariser jobs stay queued rather than spend their retries failing.
const canSummarise = Boolean(process.env.GEMINI_API_KEY);
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
    "agent-run": async (job) => {
      const outcome = await runSummariser(pool, chatModel, job);
      if (outcome) console.log(`[agents] summariser run ${job.agentRunId}: ${outcome}`);
    },
  }),
});
if (canSummarise) {
  const resumed = await resumeSummaries(pool, boss, router);
  if (resumed > 0) console.log(`[agents] resumed ${resumed} unfinished summaries`);
} else {
  console.warn("[agents] GEMINI_API_KEY is not set: summaries wait in the queue until it is");
}
console.log(`agents worker started; summariser model ${router.resolve("summariser").model}`);

const stop = async () => {
  await boss.stop();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
