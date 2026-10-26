// Agents worker: each agent run is one pg-boss job that runs one LangGraph.js graph and ends
// with one submit. Graphs are registered here as they are built (milestones 2, 3 and 5).
import { fileURLToPath } from "node:url";
import { PgBoss } from "pg-boss";
import { ModelRouter } from "./router.ts";

const router = ModelRouter.fromFile(
  fileURLToPath(new URL("../../../config/models.yaml", import.meta.url)),
);
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const boss = new PgBoss(connectionString);
boss.on("error", (error) => console.error(error));
await boss.start();
console.log(`agents worker started; summariser model ${router.resolve("summariser").model}`);

const stop = async () => {
  await boss.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
