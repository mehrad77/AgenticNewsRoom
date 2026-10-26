// Agents worker: each agent run is one pg-boss job that runs one LangGraph.js graph and ends
// with one submit. Graphs are registered here as they are built (milestones 2, 3 and 5).
import { fileURLToPath } from "node:url";
import { createBoss } from "@anr/db";
import { buildCatalog, loadModelsConfig, missingKeys, modelsFile } from "@anr/models";
import { registerJobs } from "./jobs.ts";
import { ModelRouter } from "./router.ts";

const configDir =
  process.env.ANR_CONFIG_DIR ?? fileURLToPath(new URL("../../../config", import.meta.url));
const models = loadModelsConfig(modelsFile(configDir));
const router = new ModelRouter(models);
const missing = missingKeys(buildCatalog(models));
if (missing.length > 0)
  console.warn(`[agents] models without keys are skipped: ${missing.join(", ")}`);
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const boss = createBoss(connectionString, "agents");
await boss.start();
await registerJobs(boss);
console.log(
  `agents worker started (${modelsFile(configDir)}); summariser chain ${router.resolve("summariser").join(" → ")}`,
);

const stop = async () => {
  await boss.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
