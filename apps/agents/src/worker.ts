// Agents worker: each agent run is one pg-boss job that runs one LangGraph.js graph and ends with
// one submit. The daily assignment and the verifier gate run here too.
import { fileURLToPath } from "node:url";
import type { AgentRole } from "@anr/core";
import { createBoss, createPool } from "@anr/db";
import { buildCatalog, loadModelsConfig, ModelGateway, missingKeys, modelsFile } from "@anr/models";
import { assignDaily } from "./assign.ts";
import type { RoleDeps } from "./desk/run.ts";
import { runDesk } from "./desk/run.ts";
import { dispatchAgentRun } from "./dispatch.ts";
import { handleIngestSource, ingestionClient } from "./ingest.ts";
import { registerJobs } from "./jobs.ts";
import { meteredModel } from "./model.ts";
import { runRenderer } from "./renderer/run.ts";
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

/** Whether any model a role may use has a key; a role without one waits in the queue. */
const hasKey = (chain: readonly string[]) => chain.some((id) => catalog.entries.get(id)?.apiKey);
const chains = (role: AgentRole): string[] =>
  role === "desk"
    ? [...models.roles.desk.default, ...Object.values(models.roles.desk.by_format ?? {}).flat()]
    : role === "fact-checker"
      ? [...models.roles["fact-checker"]]
      : router.resolve(role);
const canRun = (role: AgentRole) => hasKey(chains(role));

const roleDeps: RoleDeps = {
  pool,
  boss,
  router,
  configDir,
  makeModel: (chain, tokenCap) => meteredModel(gateway, chain, { tokenCap }),
  ingestion,
};
const run =
  (fn: (deps: RoleDeps, job: Parameters<typeof runDesk>[1]) => Promise<string | null>) =>
  async (job: Parameters<typeof runDesk>[1]) => {
    const outcome = await fn(roleDeps, job);
    if (outcome) console.log(`[agents] run ${job.agentRunId}: ${outcome}`);
  };

await registerJobs(boss, {
  "ingest-source": async (job) => {
    await handleIngestSource(job, {
      ingestion,
      onNewLeads: async (newsroomId, ids) => {
        await enqueueSummaries(pool, boss, router, newsroomId, ids);
      },
    });
    if (canRun("summariser")) await resumeSummaries(pool, boss, router);
  },
  assign: async (job) => {
    const outcome = await assignDaily(pool, boss, router, job);
    console.log(`[agents] assign ${job.seriesId}: ${JSON.stringify(outcome)}`);
  },
  "agent-run": dispatchAgentRun({
    pool,
    boss,
    canRun,
    handlers: {
      summariser: summariserHandler({
        pool,
        boss,
        router,
        makeModel: (chain) => gatewayModel(gateway, chain),
        throttle: Throttle.perMinute(Number(process.env.ANR_SUMMARISER_RPM ?? 10)),
      }),
      desk: run(runDesk),
      renderer: run(runRenderer),
    },
  }),
});
if (canRun("summariser")) {
  const resumed = await resumeSummaries(pool, boss, router);
  if (resumed > 0) console.log(`[agents] resumed ${resumed} unfinished summaries`);
}
for (const role of ["summariser", "desk", "renderer", "fact-checker", "item-matcher"] as const) {
  if (!canRun(role)) console.warn(`[agents] no key for any ${role} model: its runs wait`);
}
console.log(`agents worker started (${modelsFile(configDir)})`);

const stop = async () => {
  await boss.stop();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
