// Agents worker: each agent run is one pg-boss job that runs one LangGraph.js graph and ends
// with one submit. Graphs are registered here as they are built (milestones 2, 3 and 5).
import { fileURLToPath } from "node:url";
import { createBoss } from "@anr/db";
import { handleIngestSource, ingestionClient } from "./ingest.ts";
import { registerJobs } from "./jobs.ts";
import { ModelRouter } from "./router.ts";

const router = ModelRouter.fromFile(
  fileURLToPath(new URL("../../../config/models.yaml", import.meta.url)),
);
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const boss = createBoss(connectionString, "agents");
await boss.start();
const ingestion = ingestionClient(process.env.ANR_INGESTION_URL ?? "http://127.0.0.1:8101");
await registerJobs(boss, {
  "ingest-source": (job) =>
    handleIngestSource(job, {
      ingestion,
      onNewLeads: async (newsroomId, ids) => {
        console.log(`[agents] ${ids.length} new leads in ${newsroomId} wait for the summariser`);
      },
    }),
});
console.log(`agents worker started; summariser model ${router.resolve("summariser").model}`);

const stop = async () => {
  await boss.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
